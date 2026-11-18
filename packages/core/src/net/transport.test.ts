import { describe, expect, it } from "vitest";
import { assertProductionTransport } from "./transport";

const DB = "postgresql://app:pw-db-0000@db.internal.example:5432/valtrexia?sslmode=verify-full";
const REDIS = "rediss://default:pw-redis-0000@cache.internal.example:6380";

describe("assertProductionTransport", () => {
  it("accepts verified TLS to Postgres and authenticated TLS to Redis", () => {
    expect(() =>
      assertProductionTransport({ NODE_ENV: "production", DATABASE_URL: DB, REDIS_URL: REDIS }),
    ).not.toThrow();
  });

  it("checks nothing outside production", () => {
    expect(() =>
      assertProductionTransport({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://localhost/valtrexia",
        REDIS_URL: "redis://localhost:6379",
      }),
    ).not.toThrow();
  });

  it.each([
    ["postgresql://app:pw@db.example/v", /sslmode=verify-full/],
    ["postgresql://app:pw@db.example/v?sslmode=require", /sslmode=verify-full/],
    ["postgresql://app:pw@db.example/v?sslmode=verify-ca", /sslmode=verify-full/],
    ["postgresql://app:pw@db.example/v?sslmode=no-verify", /sslmode=verify-full/],
    ["postgresql://app:pw@db.example/v?sslmode=verify-full&uselibpqcompat=true", /uselibpqcompat/],
    ["mysql://db.example/v", /postgres:\/\//],
    [undefined, /postgres:\/\//],
  ])("refuses DATABASE_URL %j in production", (url, message) => {
    expect(() =>
      assertProductionTransport({ NODE_ENV: "production", DATABASE_URL: url, REDIS_URL: REDIS }),
    ).toThrow(message);
  });

  it.each([
    ["redis://default:pw@cache.example:6379", /rediss:\/\//],
    ["rediss://cache.example:6380", /password/],
    ["rediss://default@cache.example:6380", /password/],
    ["not a url", /rediss:\/\//],
  ])("refuses REDIS_URL %j in production", (url, message) => {
    expect(() =>
      assertProductionTransport({ NODE_ENV: "production", DATABASE_URL: DB, REDIS_URL: url }),
    ).toThrow(message);
  });

  it("checks only what is asked for, and never repeats a value in its message", () => {
    expect(() =>
      assertProductionTransport(
        { NODE_ENV: "production", DATABASE_URL: DB, REDIS_URL: undefined },
        { database: true },
      ),
    ).not.toThrow();
    try {
      assertProductionTransport({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://app:secret-db-pw@db.example/v",
        REDIS_URL: "redis://:secret-redis-pw@cache.example",
      });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toMatch(/secret-(db|redis)-pw/);
    }
  });
});
