package at.fhhagenberg.slopjumpers;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.concurrent.ThreadLocalRandom;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/** Rejects sampled game requests before their handlers can read or mutate data. */
@Configuration
public class RequestFailures implements WebMvcConfigurer {
    private final Scenarios scenarios;

    public RequestFailures(Scenarios scenarios) {
        this.scenarios = scenarios;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new HandlerInterceptor() {
            @Override
            public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
                int percent = scenarios.get().requestFailurePercent();
                if (ThreadLocalRandom.current().nextInt(100) < percent) {
                    response.setHeader("Cache-Control", "no-store");
                    throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "Request failed: instructor HTTP 502 fault enabled.");
                }
                return true;
            }
        }).addPathPatterns("/api/**").excludePathPatterns("/api/health", "/api/workshop", "/api/workshop/**");
    }
}
