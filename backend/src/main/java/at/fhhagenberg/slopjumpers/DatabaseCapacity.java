package at.fhhagenberg.slopjumpers;

import com.zaxxer.hikari.HikariDataSource;
import com.zaxxer.hikari.HikariPoolMXBean;
import org.springframework.stereotype.Service;
import static at.fhhagenberg.slopjumpers.Models.*;

/** Changes the real shared JDBC pool without delaying queries or interrupting transactions. */
@Service
public class DatabaseCapacity {
    private final HikariDataSource source;
    private final int defaultConnections;

    public DatabaseCapacity(HikariDataSource source) {
        this.source = source;
        defaultConnections = source.getMaximumPoolSize();
    }

    public DatabasePool status() {
        HikariPoolMXBean pool = source.getHikariPoolMXBean();
        return new DatabasePool(source.getMaximumPoolSize(), defaultConnections,
            pool == null ? 0 : pool.getActiveConnections(), pool == null ? 0 : pool.getIdleConnections(),
            pool == null ? 0 : pool.getTotalConnections(), pool == null ? 0 : pool.getThreadsAwaitingConnection(),
            source.getConnectionTimeout());
    }

    public synchronized DatabasePool limit(int connections) {
        int previous = source.getMaximumPoolSize();
        if (previous != connections) {
            // Keep the warm pool within the new maximum, in both directions.
            source.setMinimumIdle(Math.min(source.getMinimumIdle(), connections));
            source.setMaximumPoolSize(connections);
            source.setMinimumIdle(connections);
            HikariPoolMXBean pool = source.getHikariPoolMXBean();
            if (connections < previous && pool != null) {
                // Idle connections close now; borrowed connections retire when returned.
                pool.softEvictConnections();
            }
        }
        return status();
    }

    public DatabasePool reset() {
        return limit(defaultConnections);
    }
}
