package at.fhhagenberg.slopjumpers;

import java.util.ArrayList;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import static at.fhhagenberg.slopjumpers.Models.*;

@Repository
public class LeaderboardQuery {
    private final JdbcTemplate db;

    public LeaderboardQuery(JdbcTemplate db) {
        this.db = db;
    }

    public Leaderboard load() {
        // Deliberate over-fetching and N+1: return every pilot, then SELECT each nationality.
        List<RankedRun> rows = db.query("""
            SELECT alias,distance,tokens,nationality_code,finished,collision_id FROM (
              SELECT alias,distance,tokens,nationality_code,finished,collision_id,ROW_NUMBER() OVER (
                PARTITION BY player_id ORDER BY distance DESC,tokens DESC,created_at DESC,id DESC) AS row_rank
              FROM runs WHERE distance>0 AND course_version=?
            ) WHERE row_rank=1 ORDER BY distance DESC,tokens DESC
            """, (rs, n) -> new RankedRun(rs.getString(1), rs.getInt(2), rs.getInt(3), rs.getString(4),
                rs.getBoolean(5), rs.getString(6)), Levels.VERSION);
        List<Leader> entries = new ArrayList<>();
        for (RankedRun row : rows) {
            Nationality nationality = db.queryForObject("SELECT code,name FROM nationalities WHERE code=?",
                (rs, n) -> new Nationality(rs.getString(1), rs.getString(2)), row.nationalityCode());
            entries.add(new Leader(row.alias(), row.distance(), row.tokens(), nationality, row.finished(), row.collisionId()));
        }

        return new Leaderboard(System.currentTimeMillis(), entries);
    }

    private record RankedRun(String alias, int distance, int tokens, String nationalityCode, boolean finished, String collisionId) {}
}
