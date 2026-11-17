import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../logging/logger";
import { createEmailSenderFromEnv, LogEmailSender } from "./email-sender";

const lines: string[] = [];
const logger = createLogger({
  name: "email-test",
  level: "info",
  destination: new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  }),
});

describe("createEmailSenderFromEnv", () => {
  it("has no sender when nothing is configured", () => {
    expect(createEmailSenderFromEnv({}, logger)).toBeNull();
    expect(createEmailSenderFromEnv({ EMAIL_PROVIDER: "  " }, logger)).toBeNull();
  });

  it("uses the logging sender in development, and refuses it in production", () => {
    expect(createEmailSenderFromEnv({ EMAIL_PROVIDER: "log" }, logger)).toBeInstanceOf(
      LogEmailSender,
    );
    expect(() =>
      createEmailSenderFromEnv({ EMAIL_PROVIDER: "log", NODE_ENV: "production" }, logger),
    ).toThrow(/cannot be used in production/);
  });

  it("fails at once on a provider it does not know", () => {
    expect(() => createEmailSenderFromEnv({ EMAIL_PROVIDER: "carrier-pigeon" }, logger)).toThrow(
      /unknown provider/,
    );
  });
});

describe("LogEmailSender", () => {
  it("logs the subject and how many recipients, never the addresses or the body", async () => {
    lines.length = 0;
    await new LogEmailSender(logger).send({
      to: ["alex@msp.example", "sam@msp.example"],
      subject: "3 new backup problems",
      text: "body-text-must-not-be-logged",
      html: "<p>body-html-must-not-be-logged</p>",
      idempotencyKey: "batch-1",
    });
    const log = lines.join("");
    expect(log).toContain("3 new backup problems");
    expect(log).toContain('"recipients":2');
    for (const secret of ["alex@msp.example", "sam@msp.example", "body-text", "body-html"]) {
      expect(log).not.toContain(secret);
    }
  });
});
