/** Compatibility with installed clients and gateways from before the product rename. */
((root) => {
  const gatewayLoginRequired = (body) =>
    body?.chisabotAuthRequired === true || body?.openbotAuthRequired === true;

  function migrateStorage(store) {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key || !key.includes("openbot")) continue;
      const current = key.replaceAll("openbot", "chisabot");
      if (store.getItem(current) === null)
        store.setItem(current, store.getItem(key));
    }
  }

  function mountAccountMarker(document) {
    if (document.getElementById("openbot-account-control")) return;
    const marker = document.createElement("div");
    marker.id = "openbot-account-control";
    marker.hidden = true;
    document.body.appendChild(marker);
  }

  root.ChisaLegacyBrowser = {
    gatewayLoginRequired,
    migrateStorage,
    mountAccountMarker,
  };
})(globalThis);
