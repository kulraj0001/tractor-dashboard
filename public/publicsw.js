self.addEventListener("push", function (event) {
  const data = event.data ? event.data.json() : {};

  const title = data.title || "Smart Tractor Tracker";
  const options = {
    body: data.body || "New tractor alert",
    icon: "/icon.png",
    badge: "/icon.png"
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});