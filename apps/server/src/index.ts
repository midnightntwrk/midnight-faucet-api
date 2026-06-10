#!/usr/bin/env -S node --experimental-specifier-resolution=node
/* eslint-disable no-console */
import * as fs from "node:fs/promises";
import * as readline from "node:readline";
import { writeHeapSnapshot } from "node:v8";
import { pipe, Resource, Task } from "@midnight-ntwrk/faucet-utils";
import { either } from "fp-ts";
import yargs from "yargs";
import { addUser } from "./commands/add-user.js";
import { changePassword } from "./commands/change-password.js";
import { checkConnection } from "./commands/check-connection.js";
import { migrateDb } from "./commands/migrate-db.js";
import { configHelp, loadConfig, ServerConfig } from "./config.js";
import { prepareServer } from "./server.js";
import { authContextStandalone, defaultRoot } from "./composition-root.js";

process.on("SIGUSR2", () => {
  const path = `/tmp/heap-${Date.now()}.heapsnapshot`;
  console.log(`Writing heap snapshot to ${path}`);
  try {
    writeHeapSnapshot(path);
    console.log(`Heap snapshot written: ${path}`);
  } catch (err) {
    console.error(`Heap snapshot failed: ${(err as Error).message}`);
  }
});

const initConfig = () => {
  const config = loadConfig();
  return config;
};

/**
 * Read a password without exposing it in shell history or `ps` output.
 *
 * Resolution order:
 *  1. If `passwordFile` is provided, read the file and trim a trailing newline.
 *  2. Otherwise, if stdin is a TTY, prompt interactively (prompt is written to
 *     stderr so it doesn't contaminate piped stdout).
 *  3. Otherwise, read all of stdin (piped input) and trim a trailing newline.
 */
const readPassword = async (passwordFile: string | undefined): Promise<string> => {
  if (passwordFile !== undefined && passwordFile !== "") {
    const content = await fs.readFile(passwordFile, "utf8");
    const trimmed = content.replace(/\r?\n$/, "");
    if (trimmed === "") {
      throw new Error(`Password file ${passwordFile} is empty`);
    }
    return trimmed;
  }

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    return new Promise<string>((resolve, reject) => {
      rl.question("Password: ", (answer: string) => {
        rl.close();
        const value = answer.replace(/\r?\n$/, "");
        if (value === "") {
          reject(new Error("Empty password not allowed"));
        } else {
          resolve(value);
        }
      });
    });
  }

  return new Promise<string>((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      const value = data.replace(/\r?\n$/, "");
      if (value === "") {
        reject(new Error("No password provided on stdin"));
      } else {
        resolve(value);
      }
    });
    process.stdin.on("error", reject);
  });
};

// Refactored migrateDb logic into a separate function
const runMigrations = (config: ServerConfig) =>
  pipe(
    migrateDb(config),
    Task.tap((result) => {
      if (result.status === "success") {
        console.log("Migrations successful.");
      } else {
        console.error(`Migrations failed: ${result.message}`);
      }
    }),
    Task.unsafeRun,
  );

await yargs(process.argv.slice(2))
  .command("help", "Prints help", {}, () => {
    console.log(`Commands:
        - help,
        - start,
        - add-user --username {username} [--password-file {path}] [--pass-if-exists]
        - change-password --username {username} [--password-file {path}]
        - migrate-db

        Password input for add-user and change-password:
          --password-file <path>  Read password from a file (first line, trailing newline trimmed)
          (no flag)               Reads the password from stdin. If stdin is a TTY,
                                  prompts interactively; otherwise reads piped input.
      `);
    console.log("Configuration:");
    console.log(configHelp());
  })
  .command(
    "check-connection",
    "Checks connection to node and ability to load wallets",
    {},
    async (): Promise<void> => {
      console.log("Checking connection");
      return pipe(
        initConfig(),
        checkConnection,
        Task.tap((result) => {
          console.log("Connection OK.");
          console.log(`\tbalance         : ${result.balance}`);
          console.log(`\taddresses loaded: ${result.address.toString()}`);
        }),
        (t) => Task.mapVoid(t),
        (t) => Task.unsafeRun(t),
      );
    },
  )
  .command(
    "add-user",
    "Adds a user to the database",
    {
      username: { demandOption: true, type: "string" },
      passwordFile: { demandOption: false, type: "string" },
      passIfExists: { demandOption: false, type: "boolean", default: false },
    },
    async (args) => {
      console.log("Adding a user");
      let password: string;
      try {
        password = await readPassword(args.passwordFile);
      } catch (err) {
        console.error(`Could not read password: ${(err as Error).message}`);
        process.exit(1);
      }
      const config = initConfig();
      return pipe(
        config,
        authContextStandalone,
        Resource.use((root) =>
          Task.attempt(
            addUser(root, {
              username: args.username,
              password,
              passIfExists: args.passIfExists,
            }),
          ),
        ),
        Task.tap(
          either.fold(
            (error) => {
              console.log(`Could not add user: ${error.message}`);
              process.exit(1);
            },
            () => {
              console.log(`User ${args.username} added`);
              process.exit(0);
            },
          ),
        ),
        Task.mapVoid,
        Task.unsafeRun,
      );
    },
  )
  .command(
    "change-password",
    "Changes password of a user",
    {
      username: { demandOption: true, type: "string" },
      passwordFile: { demandOption: false, type: "string" },
    },
    async (args) => {
      console.log("Changing password");
      let password: string;
      try {
        password = await readPassword(args.passwordFile);
      } catch (err) {
        console.error(`Could not read password: ${(err as Error).message}`);
        process.exit(1);
      }
      const config = initConfig();
      return pipe(
        config,
        authContextStandalone,
        Resource.use((root) =>
          Task.attempt(changePassword(root, { username: args.username, password })),
        ),
        Task.tap(
          either.fold(
            (error) => {
              console.log(`Could not change password: ${error.message}`);
              process.exit(1);
            },
            () => {
              console.log(`Password of user ${args.username} changed`);
              process.exit(0);
            },
          ),
        ),
        Task.mapVoid,
        Task.unsafeRun,
      );
    },
  )
  .command(
    "migrate-db",
    "Migrates DB schema to shape that application can run with",
    {},
    async () => {
      console.log("Migrating database");
      const config = initConfig();
      await runMigrations(config);
      process.exit();
    },
  )
  .command(["start", "$0"], "Runs the server", {}, async () => {
    const config = initConfig();

    await runMigrations(config); // Ensure migrations are run before starting the server

    return pipe(
      defaultRoot(config),
      Resource.mproduct((root) => prepareServer(config, root)),
      Resource.use(() => Task.never),
      Task.unsafeRun,
    );
  })
  .help("false")
  .demandCommand().argv;
