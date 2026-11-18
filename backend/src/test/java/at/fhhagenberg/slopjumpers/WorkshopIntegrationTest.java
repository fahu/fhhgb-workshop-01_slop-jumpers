package at.fhhagenberg.slopjumpers;

import static org.assertj.core.api.Assertions.assertThat;
import com.zaxxer.hikari.HikariDataSource;
import java.net.http.HttpResponse;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Autowired;
import org.junit.jupiter.api.Test;

class WorkshopIntegrationTest extends HttpIntegrationTest {
    @Autowired HikariDataSource dataSource;
    @Autowired StartupFixtures fixtures;

    @Test
    void instructorMutationsRequireTokenAndResetPreservesRuns() throws Exception {
        start(UUID.randomUUID().toString());
        for (String path : List.of("/workshop/scenario", "/workshop/reset", "/workshop/seed")) {
            Object payload = path.endsWith("seed") ? Map.of("count", 1) : new Models.Scenario(false, 0);
            assertThat(call(path.endsWith("scenario") ? "PUT" : "POST", path, payload, false).statusCode()).isEqualTo(401);
        }
        assertThat(call("POST", "/workshop/reset", Map.of(), true).statusCode()).isEqualTo(200);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM runs", Integer.class)).isEqualTo(1);
    }

    @Test
    void databaseCapacityIsAuthorizedValidatedAndResettableEvenDuringInjectedFailures() throws Exception {
        assertThat(call("PUT", "/workshop/database", Map.of("maxConnections", 1), false).statusCode()).isEqualTo(401);
        assertThat(call("POST", "/workshop/database/reset", Map.of(), false).statusCode()).isEqualTo(401);
        for (int invalid : new int[]{0, 33}) {
            assertThat(call("PUT", "/workshop/database", Map.of("maxConnections", invalid), true).statusCode()).isEqualTo(400);
        }
        assertThat(database.status().maxConnections()).isEqualTo(database.status().defaultConnections());
        scenarios.set(new Models.Scenario(false, 100));
        var changed = call("PUT", "/workshop/database", Map.of("maxConnections", 1), true);
        assertThat(changed.statusCode()).isEqualTo(200);
        assertThat(body(changed).get("maxConnections").asInt()).isEqualTo(1);
        assertThat(scenarios.get().requestFailurePercent()).isEqualTo(100);
        assertThat(body(call("POST", "/workshop/database/reset", Map.of(), true)).get("maxConnections").asInt())
            .isEqualTo(database.status().defaultConnections());
        call("PUT", "/workshop/database", Map.of("maxConnections", 1), true);
        call("POST", "/workshop/reset", Map.of(), true);
        assertThat(scenarios.get().requestFailurePercent()).isZero();
        assertThat(database.status().maxConnections()).isEqualTo(database.status().defaultConnections());
    }

    @Test
    void realDatabasePoolQueuesTimesOutAndRecoversWithoutInterruptingBorrowedConnections() throws Exception {
        String run = start(UUID.randomUUID().toString());
        try (var connection = dataSource.getConnection()) {
            connection.setAutoCommit(false);
            assertThat(call("PUT", "/workshop/database", Map.of("maxConnections", 1), true).statusCode()).isEqualTo(200);
            // Shrinking marks the borrowed connection for later retirement; it stays usable now.
            try (var statement = connection.createStatement(); var rows = statement.executeQuery("SELECT COUNT(*) FROM runs")) {
                assertThat(rows.next()).isTrue();
                assertThat(rows.getInt(1)).isEqualTo(1);
            }
            connection.commit();
        }
        awaitCondition(() -> database.status().total() <= 1);
        try (var held = dataSource.getConnection()) {
            assertThat(held.isClosed()).isFalse();
            var read = client.sendAsync(request("GET", "/activity", null, false), HttpResponse.BodyHandlers.ofString());
            awaitCondition(() -> database.status().waiting() > 0);
            var controls = call("GET", "/workshop", null, true);
            assertThat(controls.statusCode()).isEqualTo(200);
            assertThat(body(controls).get("database").get("maxConnections").asInt()).isEqualTo(1);
            assertThat(body(controls).get("database").get("active").asInt()).isEqualTo(1);
            assertThat(read.get(3, TimeUnit.SECONDS).statusCode()).isEqualTo(503);
            assertThat(call("PUT", "/runs/" + run + "/checkpoints/1", progress(1500), false).statusCode()).isEqualTo(503);
            var recovery = client.sendAsync(request("GET", "/activity", null, false), HttpResponse.BodyHandlers.ofString());
            awaitCondition(() -> database.status().waiting() > 0);
            assertThat(call("PUT", "/workshop/database", Map.of("maxConnections", 2), true).statusCode()).isEqualTo(200);
            // New demand wakes Hikari's connection creator after its maximum is increased.
            assertThat(call("GET", "/activity", null, false).statusCode()).isEqualTo(200);
            assertThat(recovery.get(3, TimeUnit.SECONDS).statusCode()).isEqualTo(200);
            assertThat(held.isClosed()).isFalse();
        } finally {
            database.reset();
        }
        assertThat(db.queryForObject("SELECT COUNT(*) FROM checkpoints", Integer.class)).isZero();
        assertThat(call("PUT", "/runs/" + run + "/checkpoints/1", progress(1500), false).statusCode()).isEqualTo(200);
    }

    @Test
    void requestFailureFlagRejectsBeforeWritesAndCanAlwaysBeDisabled() throws Exception {
        String player = UUID.randomUUID().toString();
        String id = start(player);
        for (int invalid : new int[]{-1, 101}) {
            assertThat(call("PUT", "/workshop/scenario", new Models.Scenario(false, invalid), true).statusCode()).isEqualTo(400);
        }
        assertThat(scenarios.get().requestFailurePercent()).isZero();
        assertThat(call("PUT", "/workshop/scenario", new Models.Scenario(true, 100), true).statusCode()).isEqualTo(200);
        for (String path : List.of("/config", "/nationalities", "/levels/1", "/leaderboard", "/activity",
                "/runs?playerId=" + player, "/runs/" + id, "/players/" + player + "/profile")) {
            var response = call("GET", path, null, false);
            assertThat(response.statusCode()).as(path).isEqualTo(502);
            assertThat(response.headers().firstValue("Cache-Control")).contains("no-store");
            assertThat(body(response).get("message").asText()).contains("HTTP 502 fault");
        }
        assertThat(call("POST", "/runs", Map.of("alias", "Rejected", "playerId", player, "nationalityCode", "AT"), false).statusCode()).isEqualTo(502);
        assertThat(call("PUT", "/runs/" + id + "/checkpoints/1", progress(1500), false).statusCode()).isEqualTo(502);
        assertThat(call("PUT", "/runs/" + id + "/finish", progress(500), false).statusCode()).isEqualTo(502);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM runs", Integer.class)).isEqualTo(1);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM checkpoints", Integer.class)).isZero();
        assertThat(db.queryForObject("SELECT distance FROM runs WHERE id=?", Integer.class, id)).isZero();
        assertThat(db.queryForObject("SELECT finished FROM runs WHERE id=?", Boolean.class, id)).isFalse();
        assertThat(call("GET", "/workshop", null, true).statusCode()).isEqualTo(200);
        assertThat(call("GET", "/workshop", null, false).statusCode()).isEqualTo(401);
        assertThat(call("GET", "/health", null, false).statusCode()).isEqualTo(200);
        assertThat(call("POST", "/workshop/reset", Map.of(), true).statusCode()).isEqualTo(200);
        assertThat(scenarios.get().requestFailurePercent()).isZero();
        assertThat(call("GET", "/leaderboard", null, false).statusCode()).isEqualTo(200);
        assertThat(call("PUT", "/runs/" + id + "/checkpoints/1", progress(1500), false).statusCode()).isEqualTo(200);
    }

    @Test
    void randomRequestDelayAppliesToGameHealthAndInstructorRequests() throws Exception {
        var delay = Map.of("randomRequestDelay", true);
        assertThat(call("PATCH", "/workshop/scenario", delay, false).statusCode()).isEqualTo(401);
        assertThat(scenarios.get().randomRequestDelay()).isFalse();
        call("PUT", "/workshop/scenario", new Models.Scenario(true, 100), true);

        var enabled = call("PATCH", "/workshop/scenario", delay, true);
        assertThat(enabled.statusCode()).isEqualTo(200);
        assertThat(body(enabled).get("randomRequestDelay").asBoolean()).isTrue();
        assertThat(body(enabled).get("requestFailurePercent").asInt()).isEqualTo(100);
        assertThat(body(enabled).get("loseConfirmation").asBoolean()).isTrue();

        for (var endpoint : Map.of("/config", 502, "/health", 200, "/workshop", 200).entrySet()) {
            String route = endpoint.getKey();
            long started = System.nanoTime();
            var response = call("GET", route, null, route.equals("/workshop"));
            assertThat(response.statusCode()).as(route).isEqualTo(endpoint.getValue());
            assertThat(System.nanoTime() - started).as(route).isGreaterThanOrEqualTo(TimeUnit.MILLISECONDS.toNanos(300));
        }

        var failuresOff = call("PATCH", "/workshop/scenario", Map.of("requestFailurePercent", 0), true);
        assertThat(body(failuresOff).get("randomRequestDelay").asBoolean()).isTrue();
        var reset = call("POST", "/workshop/reset", Map.of(), true);
        assertThat(reset.statusCode()).isEqualTo(200);
        assertThat(body(reset).get("randomRequestDelay").asBoolean()).isFalse();
        assertThat(scenarios.get().randomRequestDelay()).isFalse();
    }

    @Test
    void partialRequestFailureRateProducesBothReal502sAndSuccessfulRequests() throws Exception {
        var olderClient = call("PUT", "/workshop/scenario", Map.of("loseConfirmation", true), true);
        assertThat(olderClient.statusCode()).isEqualTo(200);
        assertThat(body(olderClient).get("requestFailurePercent").asInt()).isZero();
        assertThat(body(olderClient).get("randomRequestDelay").asBoolean()).isFalse();
        assertThat(body(olderClient).get("loseConfirmation").asBoolean()).isTrue();
        assertThat(call("PUT", "/workshop/scenario", new Models.Scenario(false, 25), true).statusCode()).isEqualTo(200);
        Map<Integer, Integer> statuses = new HashMap<>();
        for (int i = 0; i < 100; i++) {
            int status = call("GET", "/config", null, false).statusCode();
            statuses.merge(status, 1, Integer::sum);
        }
        // Sampling is probabilistic; a small batch is not an exact percentage quota.
        assertThat(statuses.keySet()).containsExactlyInAnyOrder(200, 502);
        assertThat(call("PUT", "/workshop/scenario", new Models.Scenario(false, 0), true).statusCode()).isEqualTo(200);
        for (int i = 0; i < 10; i++) {
            assertThat(call("GET", "/config", null, false).statusCode()).isEqualTo(200);
        }
    }

    @Test
    void newClientFakeRunsRequireInstructorAccessAndEnforceTheirDistanceCap() throws Exception {
        var input = Map.of("alias", "James Brown", "playerId", UUID.randomUUID().toString(), "nationalityCode", "AT", "fake", true);
        assertThat(call("POST", "/runs", input, false).statusCode()).isEqualTo(401);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM runs", Integer.class)).isZero();
        var response = call("POST", "/runs", input, true);
        assertThat(response.statusCode()).isEqualTo(201);
        assertThat(body(response).get("fakeSource").asText()).isEqualTo("client");
        String id = body(response).get("id").asText();
        assertThat(call("PUT", "/runs/" + id + "/finish", progress(8001), false).statusCode()).isEqualTo(400);
        assertThat(call("PUT", "/runs/" + id + "/finish", progress(8000), false).statusCode()).isEqualTo(200);
        String human = start(UUID.randomUUID().toString());
        assertThat(call("PUT", "/runs/" + human + "/finish", progress(8001), false).statusCode()).isEqualTo(200);
        assertThat(db.queryForObject("SELECT fake_source FROM runs WHERE id=?", String.class, human)).isNull();
    }

    @Test
    void seedCreatesDistinctRandomPlayersAndRemovalOnlyDeletesExplicitlyMarkedRuns() throws Exception {
        // Legacy fixtures (synthetic=TRUE), earlier client runs and ordinary runs stay unmarked.
        fixtures.seed(4);
        String player = UUID.randomUUID().toString();
        String old = start(player);
        db.update("UPDATE runs SET alias='Lab old run' WHERE id=?", old);
        call("PUT", "/runs/" + old + "/checkpoints/1", progress(1500), false);
        start(player);
        var protectedRuns = db.queryForList("SELECT * FROM runs ORDER BY id");
        var protectedCheckpoints = db.queryForList("SELECT * FROM checkpoints ORDER BY run_id,checkpoint_no");
        assertThat(call("GET", "/workshop/runs", null, false).statusCode()).isEqualTo(401);
        assertThat(call("DELETE", "/workshop/fake-runs", null, false).statusCode()).isEqualTo(401);
        for (int invalid : new int[]{0, 10001}) {
            assertThat(call("POST", "/workshop/seed", Map.of("count", invalid), true).statusCode()).isEqualTo(400);
        }
        var seeded = call("POST", "/workshop/seed", Map.of("count", 1001), true);
        assertThat(seeded.statusCode()).isEqualTo(200);
        assertThat(body(seeded).get("added").asInt()).isEqualTo(1001);
        assertThat(db.queryForObject("SELECT COUNT(DISTINCT player_id) FROM runs WHERE fake_source='seed'", Integer.class)).isEqualTo(1001);
        assertThat(db.queryForObject("SELECT COUNT(DISTINCT alias) FROM runs WHERE fake_source='seed'", Integer.class)).isEqualTo(1001);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM runs WHERE fake_source='seed' AND (distance<1 OR distance>8000 OR finished=FALSE OR synthetic=FALSE OR collision_id IS NULL)", Integer.class)).isZero();
        assertThat(db.queryForObject("SELECT COUNT(DISTINCT distance) FROM runs WHERE fake_source='seed'", Integer.class)).isGreaterThan(100);
        var seededDistances = db.queryForList("SELECT distance FROM runs WHERE fake_source='seed'", Integer.class);
        assertThat(seededDistances.stream().filter(distance -> distance < 1500).count()).isBetween(750L, 920L);
        assertThat(seededDistances.stream().filter(distance -> distance >= 5000).count()).isLessThan(15);
        assertThat(db.queryForObject("SELECT COUNT(*) FROM checkpoints c JOIN runs r ON r.id=c.run_id WHERE r.fake_source='seed' AND (c.distance>r.distance OR c.tokens>r.tokens OR c.elapsed_ms>r.elapsed_ms)", Integer.class)).isZero();
        var clientRun = body(call("POST", "/runs", Map.of("alias", "Mary Davis", "playerId", UUID.randomUUID().toString(), "nationalityCode", "DE", "fake", true), true));
        String id = clientRun.get("id").asText();
        assertThat(call("PUT", "/runs/" + id + "/checkpoints/1", progress(1500), false).statusCode()).isEqualTo(200);
        var response = call("GET", "/workshop/runs", null, true);
        assertThat(response.headers().firstValue("Cache-Control")).hasValue("no-store");
        var counts = body(response);
        assertThat(counts.get("totalRuns").asInt()).isEqualTo(1008);
        assertThat(counts.get("rankedPlayers").asInt()).isEqualTo(1007);
        assertThat(counts.get("recentPlayers").asInt()).isEqualTo(2);
        assertThat(counts.get("startedOnlyRuns").asInt()).isEqualTo(1);
        assertThat(counts.get("removableFakeRuns").asInt()).isEqualTo(1002);
        assertThat(counts.get("protectedRuns").asInt()).isEqualTo(6);
        int checkpointCount = db.queryForObject("SELECT COUNT(*) FROM checkpoints", Integer.class);
        var removed = call("DELETE", "/workshop/fake-runs", null, true);
        assertThat(removed.statusCode()).isEqualTo(200);
        assertThat(body(removed).get("runs").asInt()).isEqualTo(1002);
        assertThat(body(removed).get("checkpoints").asInt()).isEqualTo(checkpointCount - protectedCheckpoints.size());
        assertThat(db.queryForList("SELECT * FROM runs ORDER BY id")).isEqualTo(protectedRuns);
        assertThat(db.queryForList("SELECT * FROM checkpoints ORDER BY run_id,checkpoint_no")).isEqualTo(protectedCheckpoints);
        assertThat(body(call("DELETE", "/workshop/fake-runs", null, true)).get("runs").asInt()).isZero();
        assertThat(body(call("GET", "/activity", null, false)).get("players").asInt()).isEqualTo(1);
    }
}
