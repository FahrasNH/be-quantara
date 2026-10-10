"use strict";

const assert = require("assert");
const axios = require("axios");
const XaiClient = require("../src/infrastructure/xai/XaiClient");

async function run() {
  const originalPost = axios.post;
  let requestCount = 0;

  axios.post = async () => {
    requestCount += 1;
    const error = new Error("Request failed with status code 403");
    error.response = {
      status: 403,
      data: {
        code: "permission-denied",
        error: "Your team has either used all available credits or reached its monthly spending limit.",
      },
    };
    throw error;
  };

  try {
    const client = new XaiClient({
      apiKey: "test-key",
      model: "grok-4.3",
      errorCooldownMs: 60_000,
    });

    await assert.rejects(
      client.chat([{ role: "user", content: "{}" }]),
      (error) => {
        assert.strictEqual(error.code, "XAI_CREDITS_EXHAUSTED");
        assert.strictEqual(error.status, 403);
        assert.match(error.message, /credit habis|monthly spending limit/i);
        return true;
      },
    );

    await assert.rejects(
      client.chat([{ role: "user", content: "{}" }]),
      (error) => {
        assert.strictEqual(error.code, "XAI_CREDITS_EXHAUSTED");
        assert.strictEqual(error.cooldown, true);
        assert.match(error.message, /Retry sekitar/i);
        return true;
      },
    );

    assert.strictEqual(requestCount, 1, "cooldown should prevent repeated xAI requests");
    console.log("xai-client-errors.test.js: all assertions passed");
  } finally {
    axios.post = originalPost;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
