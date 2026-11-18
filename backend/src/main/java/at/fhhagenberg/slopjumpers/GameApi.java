package at.fhhagenberg.slopjumpers;

import jakarta.validation.Valid;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import static at.fhhagenberg.slopjumpers.Models.*;

@RestController
@RequestMapping("/api")
public class GameApi {
    private final Runs runs;
    private final LeaderboardService leaderboard;
    private final Scenarios scenarios;
    private final WorkshopAccess access;
    private final Nationalities nationalities;
    private final Levels levels;

    public GameApi(Runs runs, LeaderboardService leaderboard, Scenarios scenarios,
                   WorkshopAccess access, Nationalities nationalities, Levels levels) {
        this.runs = runs;
        this.leaderboard = leaderboard;
        this.scenarios = scenarios;
        this.access = access;
        this.nationalities = nationalities;
        this.levels = levels;
    }

    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "UP");
    }

    @GetMapping("/config")
    public Map<String, Object> config() {
        return Map.of("mapVersion", Levels.VERSION, "levelMeters", Levels.LENGTH, "speed", 60, "maxSpeed", 130);
    }

    @GetMapping("/nationalities")
    public List<Nationality> nationalities() {
        return nationalities.list();
    }

    @GetMapping("/levels/{number}")
    public Level level(@PathVariable int number) {
        return levels.get(number);
    }

    @GetMapping("/leaderboard")
    public Leaderboard leaderboard() {
        return leaderboard.load();
    }

    @GetMapping("/activity")
    public ResponseEntity<PlayerActivity> activity() {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(runs.activity());
    }

    @PostMapping("/runs")
    @ResponseStatus(HttpStatus.CREATED)
    public Run start(
        @RequestHeader(name = WorkshopAccess.TOKEN_HEADER, required = false) String token,
        @Valid @RequestBody Start input) {
        if (Boolean.TRUE.equals(input.fake())) {
            access.requireToken(token);
        }
        return runs.start(input);
    }

    @GetMapping("/runs")
    public List<Run> history(@RequestParam String playerId) {
        return runs.history(playerId);
    }

    @GetMapping("/players/{playerId}/profile")
    public ResponseEntity<PlayerProfile> profile(@PathVariable String playerId) {
        PlayerProfile profile = runs.profile(playerId);
        return ResponseEntity.status(profile == null ? HttpStatus.NO_CONTENT : HttpStatus.OK)
            .cacheControl(CacheControl.noStore()).body(profile);
    }

    @GetMapping("/personal-best")
    public Map<String, Integer> personalBest(@RequestParam String playerId) {
        return Map.of("distance", runs.personalBest(playerId));
    }

    @GetMapping("/runs/{id}")
    public Run run(@PathVariable String id) {
        return runs.get(id);
    }

    @PutMapping("/runs/{id}/checkpoints/{checkpoint}")
    public Receipt checkpoint(@PathVariable String id, @PathVariable int checkpoint, @Valid @RequestBody Progress progress) {
        Scenario scenario = scenarios.get();
        Receipt receipt = runs.save(id, checkpoint, progress, false);
        // This failure happens AFTER the transaction has committed.
        if (scenario.loseConfirmation() && runs.loseConfirmationOnce(id, checkpoint)) {
            throw new ResponseStatusException(HttpStatus.GATEWAY_TIMEOUT, "Confirmation was interrupted. Check your history or retry the same checkpoint.");
        }
        return receipt;
    }

    @PutMapping("/runs/{id}/finish")
    public Receipt finish(@PathVariable String id, @Valid @RequestBody Progress progress) {
        return runs.save(id, 0, progress, true);
    }
}
