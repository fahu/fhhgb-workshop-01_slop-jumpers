package at.fhhagenberg.slopjumpers;

import static org.assertj.core.api.Assertions.assertThat;
import java.net.URI;
import java.time.Duration;
import java.net.http.*;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "server.address=127.0.0.1",
    "spring.datasource.url=${SLOP_JUMPERS_TEST_DATABASE_URL:jdbc:h2:mem:slop-jumpers-test;DB_CLOSE_DELAY=-1}",
    "spring.datasource.username=${SLOP_JUMPERS_TEST_DATABASE_USERNAME:sa}",
    "spring.datasource.password=${SLOP_JUMPERS_TEST_DATABASE_PASSWORD:}",
    "slop-jumpers.workshop-token=test-instructor", "slop-jumpers.seed-size=0",
    "slop-jumpers.leaderboard-workers=1",
    "spring.datasource.hikari.connection-timeout=2500", "spring.datasource.hikari.validation-timeout=250",
    "slop-jumpers.leaderboard-queue=2", "slop-jumpers.leaderboard-deadline-ms=1000"
})
abstract class HttpIntegrationTest {
    @LocalServerPort int port;
    @Autowired JdbcTemplate db;
    @Autowired Scenarios scenarios;
    @Autowired LeaderboardService board;
    @Autowired DatabaseCapacity database;
    final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    private final JsonMapper json = JsonMapper.builder().build();

    @BeforeEach
    void baseline() throws Exception {
        awaitCondition(() -> board.status().active() == 0 && board.status().queued() == 0);
        scenarios.set(new Models.Scenario(false, 0));
        database.reset();
        db.update("DELETE FROM checkpoints");
        db.update("DELETE FROM runs");
    }

    HttpRequest request(String method, String path, Object body, boolean instructor) {
        var builder = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api" + path))
            .timeout(Duration.ofSeconds(8))
            .header("Content-Type", "application/json");
        if (instructor) {
            builder.header("X-Workshop-Token", "test-instructor");
        }
        return builder.method(method, body == null ? HttpRequest.BodyPublishers.noBody() :
            HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build();
    }

    HttpResponse<String> call(String method, String path, Object body, boolean instructor) throws Exception {
        return client.send(request(method, path, body, instructor), HttpResponse.BodyHandlers.ofString());
    }

    JsonNode body(HttpResponse<String> response) {
        return json.readTree(response.body());
    }

    String start(String player) throws Exception {
        var response = call("POST", "/runs", Map.of("alias", "Test runner", "playerId", player, "nationalityCode", "AT"), false);
        assertThat(response.statusCode()).isEqualTo(201);
        return body(response).get("id").asText();
    }

    Map<String, Object> progress(int distance) {
        return Map.of("distance", distance, "tokens", distance / 16, "elapsedMs", distance * 50);
    }

    void awaitCondition(BooleanSupplier condition) throws InterruptedException {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (!condition.getAsBoolean() && System.nanoTime() < until) {
            Thread.sleep(5);
        }
        assertThat(condition.getAsBoolean()).as("expected server state within 2 seconds").isTrue();
    }
}
