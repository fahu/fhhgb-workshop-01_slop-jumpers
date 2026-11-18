package at.fhhagenberg.slopjumpers;

import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/** Retains the original SEED_SIZE fixtures, which predate the removable fake-data tools. */
@Component
@Order(10)
public class StartupFixtures implements ApplicationRunner {
    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private final int seedSize;

    public StartupFixtures(JdbcTemplate db, TransactionTemplate tx, @Value("${slop-jumpers.seed-size}") int seedSize) {
        this.db = db;
        this.tx = tx;
        this.seedSize = seedSize;
    }

    @Override
    public void run(ApplicationArguments args) {
        if (seedSize > 0 && db.queryForObject("SELECT COUNT(*) FROM runs WHERE course_version=?", Long.class, Levels.VERSION) == 0) {
            seed(seedSize);
        }
    }

    void seed(int count) {
        String[] aliases = {"Mila", "Noah", "Lea", "Felix", "Emilia", "Jonas", "Hanna", "Luca"};
        tx.executeWithoutResult(status -> {
            for (int i = 0; i < count; i++) {
                String id = UUID.randomUUID().toString();
                // Retain the original namespace for these deterministic fixture identities.
                String player = UUID.nameUUIDFromBytes(("slop-jumper-seed-" + (i % 40)).getBytes(StandardCharsets.UTF_8)).toString();
                int distance = 350 + (i * 137 % 6000);
                int tokens = distance / 90;
                long created = System.currentTimeMillis() - 900000 - i * 12000L;
                String alias = aliases[i % aliases.length] + (i % 40 < 8 ? "" : " " + (i % 40));
                db.update("INSERT INTO runs(id,player_id,alias,distance,tokens,elapsed_ms,finished,synthetic,created_at,updated_at,nationality_code,course_version,level_length) VALUES(?,?,?,?,?,?,TRUE,TRUE,?,?,?,?,?)",
                    id, player, alias, distance, tokens, distance * 20L, created, created,
                    new String[]{"AT", "DE", "CH", "IT", "CZ", "FR", "GB", "US"}[i % 8], Levels.VERSION, Levels.LENGTH);
                for (int c = 1; c <= distance / Levels.LENGTH; c++) {
                    db.update("INSERT INTO checkpoints(run_id,checkpoint_no,distance,tokens,elapsed_ms,created_at) VALUES(?,?,?,?,?,?)",
                        id, c, c * Levels.LENGTH, c * 16, c * 25000L, created + c * 1000L);
                }
            }
        });
    }
}
