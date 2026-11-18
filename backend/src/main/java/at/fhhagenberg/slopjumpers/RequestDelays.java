package at.fhhagenberg.slopjumpers;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.concurrent.ThreadLocalRandom;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.filter.OncePerRequestFilter;

@Configuration(proxyBeanMethods = false)
class RequestDelays {
    @Bean
    FilterRegistrationBean<OncePerRequestFilter> requestDelayFilter(Scenarios scenarios) {
        var filter = new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
                    throws ServletException, IOException {
                if (scenarios.get().randomRequestDelay()) {
                    try {
                        Thread.sleep(ThreadLocalRandom.current().nextInt(300, 1001));
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        response.sendError(HttpServletResponse.SC_SERVICE_UNAVAILABLE);
                        return;
                    }
                }
                chain.doFilter(request, response);
            }
        };
        var registration = new FilterRegistrationBean<OncePerRequestFilter>(filter);
        registration.addUrlPatterns("/api/*");
        return registration;
    }
}
