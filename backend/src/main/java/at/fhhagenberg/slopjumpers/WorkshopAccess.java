package at.fhhagenberg.slopjumpers;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
public class WorkshopAccess {
    static final String TOKEN_HEADER = "X-Workshop-Token";
    private final byte[] expectedToken;

    public WorkshopAccess(@Value("${slop-jumpers.workshop-token}") String token) {
        expectedToken = token.isBlank() ? new byte[0] : token.getBytes(StandardCharsets.UTF_8);
    }

    public void requireToken(String supplied) {
        if (expectedToken.length == 0 || supplied == null ||
            !MessageDigest.isEqual(expectedToken, supplied.getBytes(StandardCharsets.UTF_8))) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Enter the instructor token.");
        }
    }
}
