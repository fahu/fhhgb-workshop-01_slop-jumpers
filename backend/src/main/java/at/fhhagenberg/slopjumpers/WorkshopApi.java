package at.fhhagenberg.slopjumpers;

import jakarta.validation.Valid;
import java.util.Map;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import static at.fhhagenberg.slopjumpers.Models.*;

@RestController
@RequestMapping("/api/workshop")
public class WorkshopApi {
    private final WorkshopAccess access;
    private final Scenarios scenarios;
    private final LeaderboardService leaderboard;
    private final DatabaseCapacity database;
    private final FakeRunData fakeRunData;

    public WorkshopApi(WorkshopAccess access, Scenarios scenarios, LeaderboardService leaderboard,
                       DatabaseCapacity database, FakeRunData fakeRunData) {
        this.access = access;
        this.scenarios = scenarios;
        this.leaderboard = leaderboard;
        this.database = database;
        this.fakeRunData = fakeRunData;
    }

    @GetMapping
    public Map<String, Object> workshop(@RequestHeader(name = WorkshopAccess.TOKEN_HEADER, required = false) String token) {
        access.requireToken(token);
        return Map.of("scenario", scenarios.get(), "leaderboard", leaderboard.status(), "database", database.status());
    }

    @PutMapping("/scenario")
    public Scenario scenario(@RequestHeader(name = WorkshopAccess.TOKEN_HEADER, required = false) String token, @Valid @RequestBody Scenario scenario) {
        access.requireToken(token);
        scenarios.set(scenario);
        return scenario;
    }

    @PatchMapping("/scenario")
    public Scenario updateScenario(@RequestHeader(name = WorkshopAccess.TOKEN_HEADER, required = false) String token,
                                   @Valid @RequestBody ScenarioUpdate update) {
        access.requireToken(token);
        return scenarios.update(update);
    }

    @PostMapping("/seed")
    public Map<String, Integer> seed(@RequestHeader(name = WorkshopAccess.TOKEN_HEADER, required = false) String token, @Valid @RequestBody Seed seed) {
        access.requireToken(token);
        fakeRunData.seed(seed.count());
        return Map.of("added", seed.count());
    }

    @GetMapping("/runs")
    public ResponseEntity<RunCounts> runCounts(@RequestHeader(name = WorkshopAccess.TOKEN_HEADER, required = false) String token) {
        access.requireToken(token);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(fakeRunData.counts());
    }

    @DeleteMapping("/fake-runs")
    public RemovedRuns removeFakeRuns(@RequestHeader(name = WorkshopAccess.TOKEN_HEADER, required = false) String token) {
        access.requireToken(token);
        return fakeRunData.remove();
    }

    @PutMapping("/database")
    public DatabasePool database(@RequestHeader(name = WorkshopAccess.TOKEN_HEADER, required = false) String token, @Valid @RequestBody DatabaseLimit limit) {
        access.requireToken(token);
        return database.limit(limit.maxConnections());
    }

    @PostMapping("/database/reset")
    public DatabasePool resetDatabase(@RequestHeader(name = WorkshopAccess.TOKEN_HEADER, required = false) String token) {
        access.requireToken(token);
        return database.reset();
    }

    @PostMapping("/reset")
    public Scenario reset(@RequestHeader(name = WorkshopAccess.TOKEN_HEADER, required = false) String token) {
        access.requireToken(token);
        scenarios.set(new Scenario(false, 0));
        database.reset();
        return scenarios.get();
    }
}
