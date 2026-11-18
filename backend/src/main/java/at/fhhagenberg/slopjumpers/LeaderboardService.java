package at.fhhagenberg.slopjumpers;

import jakarta.annotation.PreDestroy;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import static at.fhhagenberg.slopjumpers.Models.*;

@Service
public class LeaderboardService {
    private final LeaderboardQuery query;
    private final ThreadPoolExecutor workers;
    private final int deadlineMs;
    private final AtomicLong builds = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong();

    public LeaderboardService(LeaderboardQuery query,
                              @Value("${slop-jumpers.leaderboard-workers}") int count,
                              @Value("${slop-jumpers.leaderboard-queue}") int queue,
                              @Value("${slop-jumpers.leaderboard-deadline-ms}") int deadlineMs) {
        this.query = query;
        this.deadlineMs = Math.max(100, deadlineMs);
        int workerCount = Math.max(1, count);
        workers = new ThreadPoolExecutor(workerCount, workerCount, 0, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(Math.max(1, queue)), Thread.ofPlatform().name("leaderboard-", 0).factory());
    }

    public Leaderboard load() {
        var task = new FutureTask<>(() -> {
            builds.incrementAndGet();
            return query.load();
        });
        try {
            workers.execute(task);
        } catch (RejectedExecutionException error) {
            rejected.incrementAndGet();
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Leaderboard queue is full. Try again shortly.");
        }
        try {
            return task.get(deadlineMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException error) {
            cancel(task);
            throw new ResponseStatusException(HttpStatus.GATEWAY_TIMEOUT, "Leaderboard refresh timed out.");
        } catch (InterruptedException error) {
            cancel(task);
            Thread.currentThread().interrupt();
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Leaderboard refresh interrupted.");
        } catch (ExecutionException error) {
            if (error.getCause() instanceof ResponseStatusException response) {
                throw response;
            }
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Leaderboard refresh failed.");
        }
    }

    private void cancel(FutureTask<Leaderboard> task) {
        // Free a queue slot immediately. A JDBC call already in progress can finish.
        task.cancel(false);
        workers.remove(task);
    }

    public LeaderboardStatus status() {
        return new LeaderboardStatus(workers.getActiveCount(), workers.getQueue().size(), builds.get(),
            rejected.get(), workers.getCorePoolSize(), deadlineMs);
    }

    @PreDestroy
    public void close() {
        workers.shutdownNow();
    }
}
