package at.fhhagenberg.slopjumpers;

import static org.assertj.core.api.Assertions.assertThat;
import com.zaxxer.hikari.HikariDataSource;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;

class LeaderboardIntegrationTest extends HttpIntegrationTest {
    @Autowired HikariDataSource dataSource;

    @Test
    void leaderboardRejectsAFullQueueAndReleasesJobsThatExceedTheDeadline() throws Exception {
        String runId = start(UUID.randomUUID().toString());
        int deadlineMs = board.status().deadlineMs();
        database.limit(1);
        awaitCondition(() -> database.status().total() <= 1);
        try (var held = dataSource.getConnection()) {
            assertThat(held.isClosed()).isFalse();
            assertThat(board.status().workers()).isEqualTo(1);
            assertThat(deadlineMs).isEqualTo(1000);
            long builds = board.status().builds();
            long rejections = board.status().rejected();
            var leaderboard = request("GET", "/leaderboard", null, false);

            // Holding the sole JDBC connection keeps the worker busy without a simulated query delay.
            var active = client.sendAsync(leaderboard, HttpResponse.BodyHandlers.ofString());
            awaitCondition(() -> database.status().waiting() == 1);
            var queuedFirst = client.sendAsync(leaderboard, HttpResponse.BodyHandlers.ofString());
            var queuedSecond = client.sendAsync(leaderboard, HttpResponse.BodyHandlers.ofString());
            awaitCondition(() -> board.status().queued() == 2);

            var rejected = call("GET", "/leaderboard", null, false);
            assertThat(rejected.statusCode()).isEqualTo(503);
            assertThat(body(rejected).get("message").asText()).contains("queue is full");
            assertThat(board.status().rejected()).isEqualTo(rejections + 1);
            assertThat(call("GET", "/levels/1", null, false).statusCode()).isEqualTo(200);
            for (var pending : List.of(active, queuedFirst, queuedSecond)) {
                assertThat(pending.get(3, TimeUnit.SECONDS).statusCode()).isEqualTo(504);
            }
            assertThat(board.status().active()).isEqualTo(1);
            assertThat(board.status().queued()).isZero();
            assertThat(board.status().builds()).isEqualTo(builds + 1);
        } finally {
            database.reset();
        }
        awaitCondition(() -> board.status().active() == 0);
        assertThat(call("PUT", "/runs/" + runId + "/checkpoints/1", progress(1500), false).statusCode()).isEqualTo(200);
        assertThat(call("GET", "/leaderboard", null, false).statusCode()).isEqualTo(200);
    }

    @Test
    void leaderboardReturnsAllPlayersAndPerformsOneRealNationalityLookupPerPlayerOnEveryRead() throws Exception {
        String player = UUID.randomUUID().toString();
        assertThat(call("POST", "/runs", Map.of("alias", "Pilot", "playerId", player), false).statusCode()).isEqualTo(400);
        assertThat(call("POST", "/runs", Map.of("alias", "Pilot", "playerId", player, "nationalityCode", "XX"), false).statusCode()).isEqualTo(400);
        for (int i = 0; i < 12; i++) {
            String id = start(i == 0 ? player : UUID.randomUUID().toString());
            call("PUT", "/runs/" + id + "/finish", progress(500 + i), false);
        }
        // Extra attempts for the same player must not duplicate the pilot in the ranking.
        String lowerScore = start(player);
        call("PUT", "/runs/" + lowerScore + "/finish", progress(10), false);
        start(UUID.randomUUID().toString()); // An unplayed start has no ranked distance yet.
        boolean postgres = dataSource.getJdbcUrl().startsWith("jdbc:postgresql:");
        if (!postgres) {
            db.execute("SET QUERY_STATISTICS TRUE");
        }
        String nationalityQuery = "SELECT code,name FROM nationalities WHERE code=";
        String rankingQuery = "SELECT alias,distance,tokens,nationality_code,finished,collision_id FROM (";
        try {
            long nationalityBefore = queryExecutions(postgres, nationalityQuery);
            long rankingBefore = queryExecutions(postgres, rankingQuery);
            for (int read = 0; read < 2; read++) {
                var response = call("GET", "/leaderboard", null, false);
                assertThat(response.statusCode()).isEqualTo(200);
                JsonNode result = body(response);
                assertThat(result.get("entries").size()).isEqualTo(12);
                for (int rank = 0; rank < 12; rank++) {
                    assertThat(result.get("entries").get(rank).get("distance").asInt()).isEqualTo(511 - rank);
                }
                assertThat(result.get("entries").get(0).get("nationality").get("name").asText()).isEqualTo("Austria");
            }
            assertThat(queryExecutions(postgres, nationalityQuery) - nationalityBefore).isEqualTo(24L);
            assertThat(queryExecutions(postgres, rankingQuery) - rankingBefore).isEqualTo(2L);
        } finally {
            if (!postgres) {
                db.execute("SET QUERY_STATISTICS FALSE");
            }
        }
    }

    private long queryExecutions(boolean postgres, String queryPrefix) {
        String sql = postgres ? """
            SELECT COALESCE(SUM(calls), 0) FROM pg_stat_statements
            WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND query LIKE ?
            """ : """
            SELECT COALESCE(SUM(EXECUTION_COUNT), 0) FROM INFORMATION_SCHEMA.QUERY_STATISTICS
            WHERE SQL_STATEMENT LIKE ?
            """;
        return db.queryForObject(sql, Long.class, queryPrefix + "%");
    }

    @Test
    void leaderboardAndHistoryKeepTheCollisionFromTheBestRun() throws Exception {
        String player = UUID.randomUUID().toString();
        String best = start(player);
        String finish = "/runs/" + best + "/finish";
        var collision = new Models.Progress(281, 1, 5000, "citation-404");
        assertThat(call("PUT", finish, new Models.Progress(281, 1, 5000, "seven-finger-hand"), false).statusCode()).isEqualTo(400);
        assertThat(call("PUT", "/runs/" + best + "/checkpoints/1", new Models.Progress(1500, 3, 25000, "citation-404"), false).statusCode()).isEqualTo(400);
        assertThat(call("PUT", finish, collision, false).statusCode()).isEqualTo(200);
        assertThat(body(call("PUT", finish, collision, false)).get("duplicate").asBoolean()).isTrue();
        assertThat(call("PUT", finish, new Models.Progress(281, 1, 5000, null), false).statusCode()).isEqualTo(409);

        String shorter = start(player);
        assertThat(call("PUT", "/runs/" + shorter + "/finish",
            new Models.Progress(176, 0, 3000, "seven-finger-hand"), false).statusCode()).isEqualTo(200);
        String manual = start(UUID.randomUUID().toString());
        assertThat(call("PUT", "/runs/" + manual + "/finish", progress(75), false).statusCode()).isEqualTo(200);
        JsonNode history = body(call("GET", "/runs?playerId=" + player, null, false));
        assertThat(history.size()).isEqualTo(2);
        assertThat(body(call("GET", "/runs/" + best, null, false)).get("collisionId").asText()).isEqualTo("citation-404");
        var ranked = body(call("GET", "/leaderboard", null, false)).get("entries");
        assertThat(ranked.size()).isEqualTo(2);
        assertThat(ranked.get(0).get("collisionId").asText()).isEqualTo("citation-404");
        assertThat(ranked.get(0).get("finished").asBoolean()).isTrue();
        assertThat(ranked.get(1).get("collisionId").isNull()).isTrue();
    }
}
