package at.fhhagenberg.slopjumpers;

import java.io.IOException;
import java.util.*;
import java.util.concurrent.ThreadLocalRandom;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;
import static at.fhhagenberg.slopjumpers.Models.*;

/** Explicitly marked workshop data; pre-existing rows are never inferred to be fake. */
@Service
public class FakeRunData {
    public static final int MAX_DISTANCE = 8000;
    private static final double SEED_OBSTACLE_SURVIVAL = 0.86;
    private static final String MARKED = "fake_source IN ('client','seed')";
    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private final Nationalities nationalities;
    private final List<Obstacle> seedObstacles;
    private final List<String> aliases;

    public FakeRunData(JdbcTemplate db, TransactionTemplate tx,
                       Nationalities nationalities, Levels levels, JsonMapper json) throws IOException {
        this.db = db;
        this.tx = tx;
        this.nationalities = nationalities;
        List<Obstacle> obstacles = new ArrayList<>();
        for (int level = 1; level <= MAX_DISTANCE / Levels.LENGTH + 1; level++) {
            obstacles.addAll(levels.obstacles(level).stream().filter(item -> item.distance() + 4 <= MAX_DISTANCE).toList());
        }
        seedObstacles = List.copyOf(obstacles);
        try (var stream = new ClassPathResource("fake-names.json").getInputStream()) {
            var names = json.readTree(stream);
            List<String> combinations = new ArrayList<>();
            for (var first : names.get("givenNames")) {
                for (var last : names.get("familyNames")) {
                    combinations.add(first.asText() + " " + last.asText());
                }
            }
            aliases = List.copyOf(combinations);
        }
    }

    public RunCounts counts() {
        long now = System.currentTimeMillis();
        return db.queryForObject("""
            SELECT COUNT(*),
              COUNT(DISTINCT CASE WHEN course_version=? AND distance>0 THEN player_id END),
              COUNT(DISTINCT CASE WHEN course_version=? AND synthetic=FALSE
                AND updated_at>=? AND updated_at<=? THEN player_id END),
              COUNT(CASE WHEN course_version=? AND distance=0 THEN 1 END),
              COUNT(CASE WHEN fake_source IN ('client','seed') THEN 1 END),
              COUNT(CASE WHEN fake_source IS NULL OR fake_source NOT IN ('client','seed') THEN 1 END)
            FROM runs
            """, (rs, n) -> new RunCounts(rs.getLong(1), rs.getLong(2), rs.getLong(3),
                rs.getLong(4), rs.getLong(5), rs.getLong(6)),
            Levels.VERSION, Levels.VERSION, now - 30 * 60_000L, now, Levels.VERSION);
    }

    public void seed(int count) {
        var random = ThreadLocalRandom.current();
        var names = new ArrayList<>(aliases);
        Collections.shuffle(names, random);
        var countries = nationalities.list();
        List<Object[]> runs = new ArrayList<>(count);
        List<Object[]> checkpoints = new ArrayList<>();
        long now = System.currentTimeMillis();
        // Sample a geometric distribution over course order, conditioned on a collision before the cap.
        double collisionProbability = 1 - Math.pow(SEED_OBSTACLE_SURVIVAL, seedObstacles.size());
        double logSurvival = Math.log(SEED_OBSTACLE_SURVIVAL);
        for (int i = 0; i < count; i++) {
            String id = UUID.randomUUID().toString();
            int obstacleIndex = (int) (Math.log1p(-random.nextDouble(collisionProbability)) / logSurvival);
            Obstacle obstacle = seedObstacles.get(obstacleIndex);
            int offset = (int) (obstacle.width() / 2) + 1;
            int distance = (int) obstacle.distance() + random.nextInt(-offset, offset + 1);
            int tokens = random.nextInt(distance / 60 + 1);
            long elapsed = elapsedAt(distance);
            long created = now - elapsed;
            runs.add(new Object[]{id, UUID.randomUUID().toString(), names.get(i), distance, tokens,
                elapsed, created, now, countries.get(random.nextInt(countries.size())).code(),
                Levels.VERSION, Levels.LENGTH, obstacle.slopId()});
            for (int c = 1; c <= distance / Levels.LENGTH; c++) {
                int metres = c * Levels.LENGTH;
                long at = elapsedAt(metres);
                checkpoints.add(new Object[]{id, c, metres, tokens * metres / distance, at, created + at});
            }
        }
        tx.executeWithoutResult(status -> {
            db.batchUpdate("""
                INSERT INTO runs(id,player_id,alias,distance,tokens,elapsed_ms,finished,synthetic,
                  fake_source,created_at,updated_at,nationality_code,course_version,level_length,collision_id)
                VALUES(?,?,?,?,?,?,TRUE,TRUE,'seed',?,?,?,?,?,?)
                """, runs);
            if (!checkpoints.isEmpty()) {
                db.batchUpdate("""
                    INSERT INTO checkpoints(run_id,checkpoint_no,distance,tokens,elapsed_ms,created_at)
                    VALUES(?,?,?,?,?,?)
                    """, checkpoints);
            }
        });
    }

    public RemovedRuns remove() {
        return tx.execute(status -> {
            // Lock the same parent rows as Runs.save, and use this exact ID set for both deletes.
            // Runs started by another browser after this selection belong to the next cleanup.
            List<String> ids = db.queryForList("SELECT id FROM runs WHERE " + MARKED + " ORDER BY id FOR UPDATE", String.class);
            int removedRuns = 0;
            int removedCheckpoints = 0;
            for (int offset = 0; offset < ids.size(); offset += 500) {
                var batch = ids.subList(offset, Math.min(offset + 500, ids.size()));
                String placeholders = String.join(",", Collections.nCopies(batch.size(), "?"));
                removedCheckpoints += db.update("DELETE FROM checkpoints WHERE run_id IN (" + placeholders + ")", batch.toArray());
                removedRuns += db.update("DELETE FROM runs WHERE id IN (" + placeholders + ") AND " + MARKED, batch.toArray());
            }
            return new RemovedRuns(removedRuns, removedCheckpoints);
        });
    }

    private long elapsedAt(int distance) {
        // Inverse of d = 60t + 0.4t²; 8,000 m is still below the speed cap.
        return (long) Math.ceil(2000.0 * distance / (Math.sqrt(3600 + 1.6 * distance) + 60));
    }
}
