import { bootPreview } from "./app.js";

function report(error: unknown): void {
  const box = document.getElementById("error");
  const status = document.getElementById("monitor-status");
  const message = error instanceof Error ? error.message : String(error);
  if (status) {
    status.hidden = false;
  }
  if (box) {
    box.hidden = false;
    box.textContent = message;
  }
  console.error(error);
}

window.addEventListener("error", (event) => {
  if (event.error) {
    report(event.error);
  }
});
window.addEventListener("unhandledrejection", (event) => {
  report(event.reason);
});

void bootPreview().catch(report);
