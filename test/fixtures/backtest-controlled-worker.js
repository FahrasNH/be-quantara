"use strict";

process.on("message", (msg) => {
  if (!msg || msg.type !== "start") return;

  process.send?.({
    type: "progress",
    data: { phase: "test", message: "controlled worker started", pid: process.pid },
  });

  if (msg.opts?.mode === "hold") return;

  setTimeout(() => {
    process.send?.({
      type: "done",
      result: { ok: true, workerPid: process.pid },
    });
  }, 25);
});
