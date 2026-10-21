(function () {
  "use strict";

  var count = 0;
  var button = document.getElementById("count");
  var value = button.querySelector("span");
  button.addEventListener("click", function () {
    count += 1;
    value.textContent = String(count);
  });

  var parentBlocked = false;
  var storageBlocked = false;
  try {
    void window.parent.document.body;
  } catch (_) {
    parentBlocked = true;
  }
  try {
    localStorage.setItem("artifact-test", "unsafe");
  } catch (_) {
    storageBlocked = true;
  }
  document.getElementById("isolation").textContent =
    parentBlocked && storageBlocked ? "Sandbox isolation confirmed." : "Sandbox isolation unavailable.";
}());
