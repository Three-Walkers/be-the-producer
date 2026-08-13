import assert from "node:assert/strict";
import { once } from "node:events";
import { startServer } from "../apps/api/dist/server.js";

const originalEnvironment = {
  token: process.env.BTP_API_TOKEN,
  origins: process.env.BTP_ALLOWED_ORIGINS,
  bodyLimit: process.env.BTP_JSON_BODY_LIMIT_BYTES
};

try {
  delete process.env.BTP_API_TOKEN;
  delete process.env.BTP_ALLOWED_ORIGINS;
  delete process.env.BTP_JSON_BODY_LIMIT_BYTES;

  assert.throws(
    () => startServer(0, "0.0.0.0"),
    /non-loopback host without BTP_API_TOKEN/,
    "remote binding must fail closed without a token"
  );

  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200, "loopback health must remain available without a token");
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");

    const projects = await fetch(`${baseUrl}/projects`);
    assert.equal(projects.status, 200, "loopback API must remain compatible without a token");

    const staticUi = await fetch(`${baseUrl}/`);
    assert.equal(staticUi.status, 200, "the static UI is public");
    assert.equal(staticUi.headers.get("cache-control"), "no-cache");

    const rejectedOrigin = await fetch(`${baseUrl}/projects`, {
      headers: { origin: "https://untrusted.example" }
    });
    assert.equal(rejectedOrigin.status, 403, "cross-origin API calls must be rejected by default");

    const dnsRebindingAttempt = await fetch(`${baseUrl}/projects`, {
      headers: {
        host: "attacker.example",
        origin: "http://attacker.example"
      }
    });
    assert.equal(dnsRebindingAttempt.status, 403, "an unauthenticated loopback API must reject non-loopback Host headers");

    const rejectedPreflight = await fetch(`${baseUrl}/projects`, {
      method: "OPTIONS",
      headers: {
        origin: "https://untrusted.example",
        "access-control-request-method": "GET"
      }
    });
    assert.equal(rejectedPreflight.status, 403, "preflight must enforce the same origin policy");
  });

  process.env.BTP_API_TOKEN = "verification-token";
  process.env.BTP_ALLOWED_ORIGINS = "https://trusted.example";
  process.env.BTP_JSON_BODY_LIMIT_BYTES = "32";

  await withServer(async (baseUrl) => {
    const unauthenticated = await fetch(`${baseUrl}/projects`);
    assert.equal(unauthenticated.status, 401, "configured APIs must require a bearer token");
    assert.equal(unauthenticated.headers.get("www-authenticate"), "Bearer");
    assert.doesNotMatch(await unauthenticated.text(), /verification-token/, "responses must not disclose the token");

    const wrongToken = await fetch(`${baseUrl}/projects`, {
      headers: { authorization: "Bearer incorrect" }
    });
    assert.equal(wrongToken.status, 401);

    const authorized = await fetch(`${baseUrl}/projects`, {
      headers: { authorization: "Bearer verification-token" }
    });
    assert.equal(authorized.status, 200, "a valid bearer token must authorize API access");

    const publicHealth = await fetch(`${baseUrl}/health`);
    assert.equal(publicHealth.status, 200, "health remains public when authentication is configured");

    const publicStaticUi = await fetch(`${baseUrl}/`);
    assert.equal(publicStaticUi.status, 200, "static UI assets remain public when authentication is configured");

    const allowedOrigin = await fetch(`${baseUrl}/projects`, {
      headers: {
        authorization: "Bearer verification-token",
        origin: "https://trusted.example"
      }
    });
    assert.equal(allowedOrigin.status, 200);
    assert.equal(allowedOrigin.headers.get("access-control-allow-origin"), "https://trusted.example");
    assert.equal(allowedOrigin.headers.get("vary"), "Origin");

    const allowedPreflight = await fetch(`${baseUrl}/projects`, {
      method: "OPTIONS",
      headers: {
        origin: "https://trusted.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization"
      }
    });
    assert.equal(allowedPreflight.status, 204);
    assert.equal(allowedPreflight.headers.get("access-control-allow-origin"), "https://trusted.example");

    const wrongContentType = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: {
        authorization: "Bearer verification-token",
        "content-type": "text/plain"
      },
      body: "{}"
    });
    assert.equal(wrongContentType.status, 415);

    const malformedJson = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: {
        authorization: "Bearer verification-token",
        "content-type": "application/json"
      },
      body: "{broken"
    });
    assert.equal(malformedJson.status, 400);

    const oversizedBody = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: {
        authorization: "Bearer verification-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ name: "x".repeat(64) })
    });
    assert.equal(oversizedBody.status, 413);
  });

  console.log("API security boundary verified.");
} finally {
  restoreEnvironment("BTP_API_TOKEN", originalEnvironment.token);
  restoreEnvironment("BTP_ALLOWED_ORIGINS", originalEnvironment.origins);
  restoreEnvironment("BTP_JSON_BODY_LIMIT_BYTES", originalEnvironment.bodyLimit);
}

async function withServer(run) {
  const server = startServer(0, "127.0.0.1");
  try {
    if (!server.listening) {
      await once(server, "listening");
    }
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
