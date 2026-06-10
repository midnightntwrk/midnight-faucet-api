import { Task } from "@midnight-ntwrk/faucet-utils";

export class CaptchaVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptchaVerificationError";
  }
}

export interface TurnstileResponse {
  success: boolean;
  challenge_ts: string;
  hostname: string;
  "error-codes"?: string[];
}

const turnstileTestToken = "XXXX.DUMMY.TOKEN.XXXX";

export class CloudflareTurnstileVerifier {
  constructor(
    private readonly secretKey: string,
    private readonly headerSecret: string,
  ) {}

  verify(token: string, headerSecret: string | string[] | undefined): Task<TurnstileResponse> {
    if (
      token === turnstileTestToken &&
      headerSecret === this.headerSecret &&
      this.headerSecret !== ""
    ) {
      return Task.of({
        success: true,
        challenge_ts: Date.now().toString(),
        hostname: "localhost",
      });
    }
    return Task.lift(async () => {
      const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: this.secretKey,
          response: token,
        }),
      });

      const result = (await response.json()) as TurnstileResponse;

      if (!result.success) {
        throw new CaptchaVerificationError(
          `Captcha verification failed: ${result["error-codes"]?.join(", ") || "unknown error"}`,
        );
      }
      return result;
    });
  }
}
