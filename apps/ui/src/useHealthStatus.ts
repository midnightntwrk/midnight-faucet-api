import { useEffect, useState } from "react";
import { Observable } from "rxjs";
import { HealthStatus } from "@midnightntwrk/faucet-internal-api";

export function useHealthStatus(healthStatus$: Observable<HealthStatus>) {
  const [isHealthy, setIsHealthy] = useState<boolean | null>(null);

  useEffect(() => {
    const subscription = healthStatus$.subscribe((status) => {
      setIsHealthy(status.status === "ok");
    });

    return () => subscription.unsubscribe();
  }, [healthStatus$]);

  return isHealthy;
}
