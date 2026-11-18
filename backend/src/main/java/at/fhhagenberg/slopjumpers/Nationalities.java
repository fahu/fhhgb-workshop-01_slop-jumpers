package at.fhhagenberg.slopjumpers;

import java.util.*;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import static at.fhhagenberg.slopjumpers.Models.*;

@Component
@Order(0)
public class Nationalities implements ApplicationRunner {
    private final JdbcTemplate db;
    private final List<Nationality> values = Arrays.stream(Locale.getISOCountries())
        .map(code -> new Nationality(code, Locale.of("", code).getDisplayCountry(Locale.ENGLISH)))
        .sorted(Comparator.comparing(Nationality::name)).toList();

    public Nationalities(JdbcTemplate db) {
        this.db = db;
    }

    @Override
    public void run(ApplicationArguments args) {
        List<Object[]> countries = new ArrayList<>();
        for (Nationality nationality : values) {
            countries.add(new Object[]{nationality.code(), nationality.name()});
        }
        countries.add(new Object[]{"ZZ", "Not recorded"});
        db.batchUpdate("""
            MERGE INTO nationalities AS existing
            USING (VALUES (CAST(? AS VARCHAR(2)), CAST(? AS VARCHAR(100)))) AS incoming(code, name)
            ON existing.code = incoming.code
            WHEN MATCHED THEN UPDATE SET name = incoming.name
            WHEN NOT MATCHED THEN INSERT (code, name) VALUES (incoming.code, incoming.name)
            """, countries);
    }

    public List<Nationality> list() {
        return values;
    }

    public boolean contains(String code) {
        return values.stream().anyMatch(nationality -> nationality.code().equals(code));
    }
}
