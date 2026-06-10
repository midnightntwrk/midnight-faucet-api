import { FormEventHandler, useState } from "react";
import styles from "./styles.module.css";
import { Submit } from "./submit.js";

export type Credentials = { username: string; password: string };

export function LoginForm(props: { submit: Submit<Credentials> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const doSubmit: FormEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault();
    return props.submit.status === "ready"
      ? props.submit.doSubmit({ username, password })
      : undefined;
  };

  return (
    <div>
      <form onSubmit={doSubmit}>
        <input
          id="username"
          type="text"
          value={username}
          placeholder="Enter your username"
          onChange={(e) => setUsername(e.target.value)}
          className={styles.formInput}
        />
        <input
          id="password"
          type="password"
          value={password}
          placeholder="Enter your password"
          onChange={(e) => setPassword(e.target.value)}
          className={styles.formInput}
        />
        {props.submit.error && <p className={styles.errorMessage}>{props.submit.error}</p>}
        {props.submit.lastResult ? (
          ""
        ) : (
          <button
            type="submit"
            disabled={props.submit.status === "in_progress" || username === "" || password === ""}
          >
            {props.submit.status === "ready" ? "Log in" : "Logging in..."}
          </button>
        )}
      </form>
      <hr className={styles.hr} />
      <div className={styles.spacer}></div>
    </div>
  );
}
