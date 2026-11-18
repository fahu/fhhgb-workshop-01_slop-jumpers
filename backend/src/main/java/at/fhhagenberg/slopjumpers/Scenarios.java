package at.fhhagenberg.slopjumpers;

import java.util.concurrent.atomic.AtomicReference;
import org.springframework.stereotype.Component;
import static at.fhhagenberg.slopjumpers.Models.*;

@Component
public class Scenarios {
    private final AtomicReference<Scenario> current = new AtomicReference<>(new Scenario(false, 0));

    public Scenario get() {
        return current.get();
    }

    public void set(Scenario scenario) {
        current.set(scenario);
    }

    public Scenario update(ScenarioUpdate update) {
        return current.updateAndGet(scenario -> new Scenario(
            scenario.loseConfirmation(),
            update.requestFailurePercent() == null ? scenario.requestFailurePercent() : update.requestFailurePercent(),
            update.randomRequestDelay() == null ? scenario.randomRequestDelay() : update.randomRequestDelay()
        ));
    }
}
