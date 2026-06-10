import * as process from "process";
import dotenv from "dotenv";

dotenv.config();

export class Services {
  static readonly JIRA_URL: string | undefined = process.env.JIRA_URL;
}
