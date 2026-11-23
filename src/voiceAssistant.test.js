import test from "node:test";
import assert from "node:assert/strict";
import { speechErrorMessage } from "./voiceAssistant.js";

test("explains when the browser did not hear speech", () => {
  assert.match(speechErrorMessage("no-speech"), /не услышал/i);
});

test("explains microphone permission errors with a recovery step", () => {
  assert.match(speechErrorMessage("not-allowed"), /разреши доступ к микрофону/i);
});

test("keeps unknown recognition failures recoverable", () => {
  assert.match(speechErrorMessage("unknown-code"), /напиши вопрос текстом/i);
});

test("does not show an error for intentional cancellation", () => {
  assert.equal(speechErrorMessage("aborted"), null);
});
