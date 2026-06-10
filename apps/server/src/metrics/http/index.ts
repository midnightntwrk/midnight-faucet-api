import { Histogram } from "prom-client";

export const apiHttpRequestTimer = new Histogram({
  name: "api_http_request_duration_secs",
  help: "The duration of API HTTP requests (in seconds).",
  labelNames: ["method", "originalUrl"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});
