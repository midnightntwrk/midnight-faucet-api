import { FormEventHandler, useState, useEffect, useRef } from "react";
import { Turnstile } from "@marsidev/react-turnstile";
import styles from "./styles.module.css";
import { Submit } from "./submit.js";

export declare const TURNSTILE_SITE_KEY: string;
const TURNTILE_TEST_SITE_ID = "1x00000000000000000000AA";

export function RequestTokensForm(props: {
  submit: Submit<{ address: string; captchaToken: string }, { transactionHash: string | null }>;
  isHealthy: boolean | null;
}) {
  const [address, setAddress] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [turnstileSiteKey, setTurnstileSiteKey] = useState(TURNSTILE_SITE_KEY);
  const turnstileRef = useRef<any>(null);

  const doSubmit: FormEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault();
    return props.submit.status === "ready"
      ? props.submit.doSubmit({ address, captchaToken })
      : undefined;
  };

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const isTesting = searchParams.get("isTesting");

    if (isTesting === "true") {
      setTurnstileSiteKey(TURNTILE_TEST_SITE_ID);
    }
  }, []);

  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.defer = true;

    document.body.appendChild(script);

    // Clean up the script when the component unmounts
    return () => {
      document.body.removeChild(script);
    };
  }, []);

  useEffect(() => {
    if ((props.submit.lastResult || props.submit.error) && turnstileRef.current) {
      turnstileRef.current.reset();
      setCaptchaToken("");
    }
  }, [props.submit.lastResult, props.submit.error]);

  const isRequestReady = props.submit.status === "ready";

  const showError = (error: unknown): string | undefined => {
    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === "string") {
      return error;
    }

    return undefined;
  };

  return (
    <div>
      <form onSubmit={doSubmit}>
        <input
          id="address"
          placeholder="Enter your wallet address"
          value={address}
          readOnly={!!props.submit.lastResult || props.submit.status === "in_progress"}
          onChange={(e) => setAddress(e.target.value)}
          className={styles.formInput}
        />
        {props.submit.lastResult && (
          <p className={styles.confirmationMessage}>
            Transaction submitted. You will shortly receive 1000 tNight in your wallet. This is the
            transaction ID: {props.submit.lastResult.transactionHash}
          </p>
        )}
        {props.submit.error && !props.submit.lastResult && (
          <p className={styles.errorMessage}>{showError(props.submit.error)}</p>
        )}
        {!isRequestReady && (
          <div className={styles.loaderContainer}>
            <span className={styles.loader}></span>{" "}
            <span className={styles.loaderText}>Your transaction is being submitted.</span>
          </div>
        )}
        <Turnstile ref={turnstileRef} siteKey={turnstileSiteKey} onSuccess={setCaptchaToken} />
        {props.isHealthy === false && (
          <p className={styles.errorMessage}>
            Services are currently unavailable. Please try again later.
          </p>
        )}
        {props.submit.lastResult ? undefined : (
          <button
            type="submit"
            disabled={
              address.length === 0 ||
              props.submit.status === "in_progress" ||
              !captchaToken ||
              props.isHealthy !== true
            }
          >
            {isRequestReady ? "Request tokens" : "Processing request..."}
          </button>
        )}
      </form>
      <hr className={styles.hr} />
      <div className={styles.spacer}></div>
    </div>
  );
}
