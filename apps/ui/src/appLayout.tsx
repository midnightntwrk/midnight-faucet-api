import classNames from "classnames";
import { ReactElement } from "react";
import logoWhite from "./assets/midnight-logo.png";
import styles from "./styles.module.css";
import xLogo from "./assets/social-icon-x.svg";
import youtubeLogo from "./assets/social-icons-youtube.svg";
import linkedinLogo from "./assets/social-icons-linkedin.svg";

export const AppLayout = (props: { children: ReactElement }) => {
  const runtimeConfig = (window as any).__APP_CONFIG__ ?? {};
  const networkId = runtimeConfig.networkId ?? undefined;

  return (
    <div>
      <div className={styles.topBar}>
        <div className={classNames(styles.appContainer, styles.topBarContents)}>
          <a href="https://midnight.network" target="_blank">
            <img src={logoWhite} width={200} height={43} alt="Midnight Logo" />
          </a>
        </div>
      </div>
      <div className={classNames(styles.blackbox, styles.appContainer)}>
        <div className={styles.appContentWrapper}>
          <div className={styles.appContent}>
            <h1>Midnight {networkId} faucet</h1>
            <p>
              This faucet dispenses a small amount of test tokens called tNight. tNight is intended
              for testing purposes on Midnight's {networkId} only.
            </p>
            {props.children}
          </div>
        </div>
        <div className={styles.appFooter}>
          <ul className={styles.socialsRow}>
            <li className={styles.social}>
              <a
                href="https://www.youtube.com/channel/UCy3oZ64F3FOtjZ5sZGQNgkA"
                aria-label="Youtube"
                target="_blank"
              >
                <img src={youtubeLogo} alt="Youtube" />
              </a>
            </li>
            <li className={styles.social}>
              <a href="https://twitter.com/MidnightNtwrk" aria-label="Twitter/X" target="_blank">
                <img src={xLogo} alt="Twitter/X" />
              </a>
            </li>
            <li className={styles.social}>
              <a href="https://www.linkedin.com/showcase/midnight-ntwrk/" target="_blank">
                <img src={linkedinLogo} alt="Linkedin" />
              </a>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
};
