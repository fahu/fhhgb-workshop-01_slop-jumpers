package at.fhhagenberg.slopjumpers;

import static org.assertj.core.api.Assertions.assertThat;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import tools.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;

class RunIntegrationTest extends HttpIntegrationTest {
    @Test
    void startIsPersistedBeforeAnyProgressAndProvidesTheSavedPlayerProfile() throws Exception {
        String player = UUID.randomUUID().toString();
        String profilePath = "/players/" + player + "/profile";
        assertThat(call("GET", profilePath, null, false).statusCode()).isEqualTo(204);
        String id = start(player);
        JsonNode saved = body(call("GET", "/runs/" + id, null, false));
        assertThat(saved.get("distance").asInt()).isZero();
        assertThat(saved.get("elapsedMs").asLong()).isZero();
        assertThat(saved.get("finished").asBoolean()).isFalse();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM checkpoints WHERE run_id=?", Integer.class, id)).isZero();
        JsonNode history = body(call("GET", "/runs?playerId=" + player, null, false));
        assertThat(history.size()).isEqualTo(1);
        assertThat(history.get(0).get("id").asText()).isEqualTo(id);
        var response = call("GET", profilePath, null, false);
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.headers().firstValue("Cache-Control")).hasValue("no-store");
        assertThat(body(response).get("alias").asText()).isEqualTo("Test runner");
        assertThat(body(response).get("nationalityCode").asText()).isEqualTo("AT");
        assertThat(body(response).get("playerId").asText()).isEqualTo(player);
        assertThat(call("GET", "/players/" + UUID.randomUUID() + "/profile", null, false).statusCode()).isEqualTo(204);
        assertThat(call("GET", "/players/invalid/profile", null, false).statusCode()).isEqualTo(400);
    }

    @Test
    void profileUsesLatestStartRatherThanBestRunAndPreservesEarlierRunIdentity() throws Exception {
        String player = UUID.randomUUID().toString();
        String previous = start(player);
        call("PUT", "/runs/" + previous + "/finish", progress(3000), false);
        db.update("UPDATE runs SET created_at=1 WHERE id=?", previous);
        var response = call("POST", "/runs", Map.of("alias", "Next robot", "playerId", player, "nationalityCode", "DE"), false);
        assertThat(response.statusCode()).isEqualTo(201);
        String latest = body(response).get("id").asText();
        assertThat(db.queryForObject("SELECT distance FROM runs WHERE id=?", Integer.class, latest)).isZero();
        JsonNode profile = body(call("GET", "/players/" + player + "/profile", null, false));
        assertThat(profile.get("alias").asText()).isEqualTo("Next robot");
        assertThat(profile.get("nationalityCode").asText()).isEqualTo("DE");
        JsonNode old = body(call("GET", "/runs/" + previous, null, false));
        assertThat(old.get("alias").asText()).isEqualTo("Test runner");
        assertThat(old.get("nationalityCode").asText()).isEqualTo("AT");
    }

    @Test
    void savesCheckpointsAndFinalResultsWithPlayerHistory() throws Exception {
        String player = UUID.randomUUID().toString();
        String id = start(player);
        assertThat(call("PUT", "/runs/" + id + "/checkpoints/1", progress(1500), false).statusCode()).isEqualTo(200);
        assertThat(call("PUT", "/runs/" + id + "/checkpoints/2", progress(3000), false).statusCode()).isEqualTo(200);
        assertThat(call("PUT", "/runs/" + id + "/finish", progress(3453), false).statusCode()).isEqualTo(200);
        JsonNode history = body(call("GET", "/runs?playerId=" + player, null, false));
        assertThat(history.size()).isEqualTo(1);
        assertThat(history.get(0).get("distance").asInt()).isEqualTo(3453);
        assertThat(history.get(0).get("finished").asBoolean()).isTrue();
        assertThat(body(call("GET", "/personal-best?playerId=" + player, null, false)).get("distance").asInt()).isEqualTo(3453);
        assertThat(body(call("GET", "/runs?playerId=" + UUID.randomUUID(), null, false)).size()).isZero();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM checkpoints WHERE run_id=?", Integer.class, id)).isEqualTo(2);
        JsonNode leaderboard = body(call("GET", "/leaderboard", null, false));
        assertThat(leaderboard.get("entries").get(0).get("distance").asInt()).isEqualTo(3453);
    }

    @Test
    void concurrentRetriesWriteOneCheckpointAndRejectChangedPayload() throws Exception {
        String id = start(UUID.randomUUID().toString());
        var req = request("PUT", "/runs/" + id + "/checkpoints/1", progress(1500), false);
        List<CompletableFuture<HttpResponse<String>>> responses = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            responses.add(client.sendAsync(req, HttpResponse.BodyHandlers.ofString()));
        }
        CompletableFuture.allOf(responses.toArray(CompletableFuture[]::new)).join();
        assertThat(responses).allSatisfy(response -> assertThat(response.join().statusCode()).isEqualTo(200));
        assertThat(db.queryForObject("SELECT COUNT(*) FROM checkpoints WHERE run_id=?", Integer.class, id)).isEqualTo(1);
        assertThat(call("PUT", "/runs/" + id + "/checkpoints/1", Map.of("distance", 1500, "tokens", 99, "elapsedMs", 75000), false).statusCode()).isEqualTo(409);
    }

    @Test
    void lostConfirmationOccursAfterCommitAndRetryConfirmsTheSameWrite() throws Exception {
        scenarios.set(new Models.Scenario(true, 0));
        String id = start(UUID.randomUUID().toString());
        String path = "/runs/" + id + "/checkpoints/1";
        assertThat(call("PUT", path, progress(1500), false).statusCode()).isEqualTo(504);
        assertThat(body(call("GET", "/runs/" + id, null, false)).get("distance").asInt()).isEqualTo(1500);
        var retry = call("PUT", path, progress(1500), false);
        assertThat(retry.statusCode()).isEqualTo(200);
        assertThat(body(retry).get("duplicate").asBoolean()).isTrue();
        assertThat(db.queryForObject("SELECT COUNT(*) FROM checkpoints", Integer.class)).isEqualTo(1);
    }

    @Test
    void finalSaveIsIdempotentAndFinalizedRunsCannotChange() throws Exception {
        String id = start(UUID.randomUUID().toString());
        String path = "/runs/" + id + "/finish";
        assertThat(call("PUT", path, progress(300), false).statusCode()).isEqualTo(200);
        assertThat(body(call("PUT", path, progress(300), false)).get("duplicate").asBoolean()).isTrue();
        assertThat(call("PUT", path, progress(301), false).statusCode()).isEqualTo(409);
        assertThat(call("PUT", "/runs/" + id + "/checkpoints/2", progress(3000), false).statusCode()).isEqualTo(409);
    }

    @Test
    void rejectsInvalidProgressAndBackwardsUpdates() throws Exception {
        String id = start(UUID.randomUUID().toString());
        assertThat(call("PUT", "/runs/" + id + "/checkpoints/1", progress(199), false).statusCode()).isEqualTo(400);
        assertThat(call("PUT", "/runs/" + id + "/checkpoints/1", Map.of("distance", 1500, "tokens", 10, "elapsedMs", 10), false).statusCode()).isEqualTo(400);
        assertThat(call("PUT", "/runs/" + id + "/checkpoints/2", progress(3000), false).statusCode()).isEqualTo(200);
        assertThat(call("PUT", "/runs/" + id + "/checkpoints/1", progress(1500), false).statusCode()).isEqualTo(409);
        assertThat(call("POST", "/runs", Map.of("alias", "   ", "playerId", UUID.randomUUID().toString()), false).statusCode()).isEqualTo(400);
    }

    @Test
    void activityCountsDistinctRecentPlayersAndExcludesFixturesAndOldActivity() throws Exception {
        assertThat(body(call("GET", "/activity", null, false)).get("players").asLong()).isZero();
        call("POST", "/workshop/seed", Map.of("count", 4), true);
        String repeatedPlayer = UUID.randomUUID().toString();
        start(repeatedPlayer);
        start(repeatedPlayer);
        String recent = start(UUID.randomUUID().toString());
        String returning = start(UUID.randomUUID().toString());
        String expired = start(UUID.randomUUID().toString());
        String earlierCircuit = start(UUID.randomUUID().toString());
        String future = start(UUID.randomUUID().toString());
        long now = System.currentTimeMillis();
        db.update("UPDATE runs SET updated_at=? WHERE id=?", now - 29 * 60_000L, recent);
        db.update("UPDATE runs SET created_at=?,updated_at=? WHERE id=?", now - 60 * 60_000L, now, returning);
        db.update("UPDATE runs SET updated_at=? WHERE id=?", now - 31 * 60_000L, expired);
        db.update("UPDATE runs SET course_version='alpine-v1' WHERE id=?", earlierCircuit);
        db.update("UPDATE runs SET updated_at=? WHERE id=?", now + 60_000L, future);
        var response = call("GET", "/activity", null, false);
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.headers().firstValue("Cache-Control")).contains("no-store");
        assertThat(body(response).get("players").asLong()).isEqualTo(3);
        assertThat(body(response).get("windowMinutes").asInt()).isEqualTo(30);
        assertThat(body(response).get("asOf").asLong()).isGreaterThanOrEqualTo(now);
        // Saving new progress brings an expired player back into the window.
        call("PUT", "/runs/" + expired + "/finish", progress(500), false);
        assertThat(body(call("GET", "/activity", null, false)).get("players").asLong()).isEqualTo(4);
    }

    @Test
    void levelsHaveFixedGeometryAndLoadAt1500MetreBoundaries() throws Exception {
        var first = body(call("GET", "/levels/1", null, false));
        var second = body(call("GET", "/levels/2", null, false));
        var third = body(call("GET", "/levels/3", null, false));
        assertThat(first).isEqualTo(body(call("GET", "/levels/1", null, false)));
        assertThat(first.get("start").asInt()).isZero();
        assertThat(first.get("end").asInt()).isEqualTo(1500);
        assertThat(second.get("start").asInt()).isEqualTo(1500);
        assertThat(second.get("end").asInt()).isEqualTo(3000);
        Set<String> allItems = new HashSet<>();
        for (var belt : List.of(first, second, third)) {
            var obstacles = belt.get("obstacles");
            assertThat(obstacles.size()).isEqualTo(12);
            Set<String> items = new HashSet<>();
            obstacles.forEach(item -> items.add(item.get("slopId").asText()));
            assertThat(items).hasSize(12);
            allItems.addAll(items);
        }
        assertThat(allItems).hasSize(32);
        assertThat(first.get("obstacles").get(2).get("slopId").asText()).isEqualTo("em-dash-avalanche");
        Set<Integer> heights = new HashSet<>();
        first.get("stars").forEach(star -> heights.add(star.get("height").asInt()));
        assertThat(heights).containsExactlyInAnyOrder(14, 106);
        assertThat(call("GET", "/levels/0", null, false).statusCode()).isEqualTo(400);
        String id = start(UUID.randomUUID().toString());
        assertThat(call("PUT", "/runs/" + id + "/checkpoints/1", progress(200), false).statusCode()).isEqualTo(400);
    }

    @Test
    void expandedBeltAcceptsNewCrashesAndPendingSavesFromTheOriginalLayout() throws Exception {
        String fresh = start(UUID.randomUUID().toString());
        String previous = start(UUID.randomUUID().toString());
        int distance = 390;
        var newCrash = new Models.Progress(distance, 1, 7000, "em-dash-avalanche");
        var originalCrash = new Models.Progress(distance, 1, 7000, "seo-spaghetti");
        var wrongSlot = new Models.Progress(distance, 1, 7000, "vibe-coded-toaster");
        assertThat(call("PUT", "/runs/" + fresh + "/finish", wrongSlot, false).statusCode()).isEqualTo(400);
        assertThat(call("PUT", "/runs/" + fresh + "/finish", newCrash, false).statusCode()).isEqualTo(200);
        assertThat(call("PUT", "/runs/" + previous + "/finish", originalCrash, false).statusCode()).isEqualTo(200);
        var leaderboard = body(call("GET", "/leaderboard", null, false));
        Set<String> causes = new HashSet<>();
        leaderboard.get("entries").forEach(score -> causes.add(score.get("collisionId").asText()));
        assertThat(causes).containsExactlyInAnyOrder("em-dash-avalanche", "seo-spaghetti");
    }

    @Test
    void existingRunsKeepTheirOldCheckpointLengthAndCanRetrySavedProgress() throws Exception {
        String id = UUID.randomUUID().toString();
        db.update("INSERT INTO runs(id,player_id,alias,created_at,updated_at,course_version,level_length) VALUES(?,?,?,?,?,?,?)", id, UUID.randomUUID().toString(), "Earlier runner", 1, 1, "previous-course", 200);
        assertThat(call("PUT", "/runs/" + id + "/checkpoints/1", progress(200), false).statusCode()).isEqualTo(200);
        assertThat(body(call("PUT", "/runs/" + id + "/checkpoints/1", progress(200), false)).get("duplicate").asBoolean()).isTrue();
        assertThat(body(call("GET", "/leaderboard", null, false)).get("entries").size()).isZero();
    }
}
