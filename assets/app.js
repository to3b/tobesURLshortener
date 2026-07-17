import {
  canonicalise,
  cloneRedirects,
  diffRedirects,
  filterRedirects,
  keyValidationMessage,
  normaliseDestination,
  normaliseKey,
  parseRedirectFile,
  serialiseRedirects,
  validateKey,
  validateRedirectMap,
} from "./redirects.js";

const root = document.documentElement;
const config = Object.freeze({
  domain: root.dataset.domain || "t-b.es",
  authApi: root.dataset.authApi || "https://auth.t-b.es",
  repository: root.dataset.repository || "to3b/tobesURLshortener",
  branch: root.dataset.branch || "main",
  file: root.dataset.file || "hello.txt",
});

const [owner, repository] = config.repository.split("/", 2);
const githubFileEndpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${encodeURIComponent(config.file)}`;
const draftKey = `tbes-draft:${config.repository}:${config.branch}:${config.file}`;

const state = {
  authenticated: false,
  user: null,
  csrfToken: "",
  redirects: {},
  baseline: {},
  sha: "",
  filter: "",
  busy: "",
  editingKey: "",
  loading: true,
  allowNavigation: false,
};

const elements = {
  connection: document.getElementById("connection"),
  connectionLabel: document.getElementById("connection-label"),
  accountBadge: document.getElementById("account-badge"),
  avatar: document.getElementById("avatar"),
  avatarPlaceholder: document.getElementById("avatar-placeholder"),
  identityName: document.getElementById("identity-name"),
  identityDetail: document.getElementById("identity-detail"),
  loginButton: document.getElementById("login-button"),
  logoutButton: document.getElementById("logout-button"),
  form: document.getElementById("redirect-form"),
  editorKicker: document.getElementById("editor-kicker"),
  editorTitle: document.getElementById("editor-title"),
  key: document.getElementById("key"),
  destination: document.getElementById("destination"),
  stageButton: document.getElementById("stage-button"),
  clearButton: document.getElementById("clear-button"),
  cancelEditButton: document.getElementById("cancel-edit-button"),
  search: document.getElementById("search"),
  reloadButton: document.getElementById("reload-button"),
  list: document.getElementById("redirect-list"),
  redirectCount: document.getElementById("redirect-count"),
  changeCount: document.getElementById("change-count"),
  changesPanel: document.getElementById("changes-panel"),
  changeList: document.getElementById("change-list"),
  discardButton: document.getElementById("discard-button"),
  commitMessage: document.getElementById("commit-message"),
  publishButton: document.getElementById("publish-button"),
  publishLabel: document.getElementById("publish-label"),
  status: document.getElementById("status"),
  statusMessage: document.getElementById("status-message"),
};

function changes() {
  return diffRedirects(state.baseline, state.redirects);
}

function isDirty() {
  return serialiseRedirects(state.redirects) !== serialiseRedirects(state.baseline);
}

function setStatus(message, tone = "neutral") {
  elements.statusMessage.textContent = message;
  elements.status.dataset.tone = tone;
}

function setBusy(scope = "") {
  state.busy = scope;
  renderControls();
}

async function parseResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `Request failed with HTTP ${response.status}.`);
    error.status = response.status;
    error.code = data.error || "request_failed";
    throw error;
  }
  return data;
}

async function authRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${config.authApi}${path}`, {
    ...options,
    headers,
    credentials: "include",
  });
  return parseResponse(response);
}

async function publicGithubRequest() {
  const url = new URL(githubFileEndpoint);
  url.searchParams.set("ref", config.branch);
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
    },
  });
  return parseResponse(response);
}

function saveDraft() {
  try {
    if (!isDirty() || !state.sha) {
      sessionStorage.removeItem(draftKey);
      return;
    }
    sessionStorage.setItem(
      draftKey,
      JSON.stringify({ sha: state.sha, redirects: state.redirects, savedAt: Date.now() }),
    );
  } catch (error) {
    console.warn("The staged draft could not be saved in this tab.", error);
  }
}

function clearDraft() {
  try {
    sessionStorage.removeItem(draftKey);
  } catch {
    // Storage can be unavailable in privacy-restricted browsing contexts.
  }
}

function restoreDraft(sha) {
  try {
    const saved = sessionStorage.getItem(draftKey);
    if (!saved) return "none";
    const draft = JSON.parse(saved);
    if (draft.sha !== sha) {
      clearDraft();
      return "stale";
    }
    state.redirects = validateRedirectMap(draft.redirects);
    return isDirty() ? "restored" : "none";
  } catch (error) {
    console.warn("The staged draft could not be restored.", error);
    clearDraft();
    return "invalid";
  }
}

async function checkSession() {
  try {
    const session = await authRequest("/api/session");
    state.authenticated = true;
    state.user = session.user;
    state.csrfToken = session.csrfToken;
  } catch (error) {
    if (error.status !== 401) console.warn("GitHub session check failed.", error);
    state.authenticated = false;
    state.user = null;
    state.csrfToken = "";
  }
  renderConnection();
  renderControls();
}

async function loadRedirects({ restoreSavedDraft = false } = {}) {
  setBusy("reload");
  if (state.loading) elements.list.setAttribute("aria-busy", "true");

  try {
    let redirects;
    let sha;
    if (state.authenticated) {
      const data = await authRequest("/api/redirects");
      redirects = validateRedirectMap(data.redirects);
      sha = data.sha;
    } else {
      const file = await publicGithubRequest();
      redirects = parseRedirectFile(file);
      sha = file.sha;
    }

    state.baseline = cloneRedirects(redirects);
    state.redirects = cloneRedirects(redirects);
    state.sha = sha;

    const draftResult = restoreSavedDraft ? restoreDraft(sha) : "none";
    state.loading = false;
    render();

    if (draftResult === "restored") {
      setStatus(`Recovered ${changes().length} staged ${changes().length === 1 ? "change" : "changes"} from this tab.`, "warning");
    } else if (draftResult === "stale") {
      setStatus("The saved draft was based on an older GitHub version, so it was not restored.", "warning");
    } else {
      const mode = state.authenticated ? `signed in as @${state.user.login}` : "read-only mode";
      setStatus(`Loaded ${Object.keys(redirects).length} redirects in ${mode}.`, "success");
    }
  } catch (error) {
    console.error("Could not load redirects.", error);
    state.loading = false;
    renderList();
    setStatus(`Could not load redirects: ${error.message}`, "error");
  } finally {
    elements.list.setAttribute("aria-busy", "false");
    setBusy("");
  }
}

async function reloadRedirects() {
  if (isDirty() && !window.confirm("Reloading will discard every staged change. Continue?")) return;
  clearDraft();
  cancelEdit({ focus: false });
  setStatus("Reloading the latest redirects from GitHub…");
  await loadRedirects();
}

function login() {
  saveDraft();
  state.allowNavigation = true;
  window.location.assign(`${config.authApi}/auth/login?cb=${Date.now()}`);
}

async function logout() {
  setBusy("logout");
  setStatus("Signing out…");
  try {
    await authRequest("/auth/logout", {
      method: "POST",
      headers: { "X-CSRF-Token": state.csrfToken },
    });
  } catch (error) {
    if (error.status !== 401) console.warn("Sign-out request failed.", error);
  } finally {
    state.authenticated = false;
    state.user = null;
    state.csrfToken = "";
    renderConnection();
    renderSummary();
    setBusy("");
    setStatus("Signed out. Your staged changes are still saved in this tab.", "warning");
  }
}

function stageRedirect(event) {
  event.preventDefault();
  const key = normaliseKey(elements.key.value, config.domain);
  if (!validateKey(key)) {
    setStatus(keyValidationMessage(key, config.domain), "error");
    elements.key.focus();
    return;
  }

  let destination;
  try {
    destination = normaliseDestination(elements.destination.value);
  } catch (error) {
    setStatus(error.message, "error");
    elements.destination.focus();
    return;
  }

  const originalKey = state.editingKey;
  if (originalKey && originalKey !== key && Object.hasOwn(state.redirects, key)) {
    setStatus(`${key}.${config.domain} already exists. Choose another name.`, "error");
    elements.key.focus();
    return;
  }

  const existed = Object.hasOwn(state.redirects, key);
  if (originalKey && originalKey !== key) delete state.redirects[originalKey];
  state.redirects[key] = destination;
  state.redirects = canonicalise(state.redirects);

  saveDraft();
  cancelEdit({ focus: false });
  render();
  elements.key.focus();

  const action = originalKey && originalKey !== key ? "Renamed" : existed ? "Updated" : "Added";
  setStatus(`${action} ${key}.${config.domain}. Publish when the draft is ready.`, "warning");
}

function startEdit(key) {
  state.editingKey = key;
  elements.key.value = key;
  elements.destination.value = state.redirects[key];
  renderEditor();
  elements.key.focus();
  elements.key.select();
  setStatus(`Editing ${key}.${config.domain}.`);
  if (window.matchMedia("(max-width: 980px)").matches) {
    elements.form.closest(".editor-card").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function cancelEdit({ focus = true } = {}) {
  state.editingKey = "";
  elements.form.reset();
  renderEditor();
  if (focus) elements.key.focus();
}

function removeRedirect(key) {
  if (!Object.hasOwn(state.redirects, key)) return;
  delete state.redirects[key];
  if (state.editingKey === key) cancelEdit({ focus: false });
  saveDraft();
  render();
  setStatus(`Removed ${key}.${config.domain} from the draft. You can undo it below.`, "warning");
}

function undoChange(key) {
  if (Object.hasOwn(state.baseline, key)) state.redirects[key] = state.baseline[key];
  else delete state.redirects[key];
  state.redirects = canonicalise(state.redirects);
  if (state.editingKey === key) cancelEdit({ focus: false });
  saveDraft();
  render();
  setStatus(`Undid the staged change to ${key}.${config.domain}.`, "success");
}

function discardAll() {
  if (!isDirty()) return;
  if (!window.confirm("Discard every staged change and return to the live redirect list?")) return;
  state.redirects = cloneRedirects(state.baseline);
  clearDraft();
  cancelEdit({ focus: false });
  render();
  setStatus("All staged changes were discarded.", "success");
}

async function copyShortLink(key) {
  const shortLink = `https://${key}.${config.domain}/`;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(shortLink);
    } else {
      const input = document.createElement("textarea");
      input.value = shortLink;
      input.setAttribute("readonly", "");
      input.className = "visually-hidden";
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setStatus(`Copied ${shortLink}`, "success");
  } catch (error) {
    console.warn("Clipboard copy failed.", error);
    setStatus(`Could not copy automatically. The short link is ${shortLink}`, "warning");
  }
}

async function publish() {
  if (!state.authenticated) {
    setStatus("Sign in with GitHub before publishing.", "warning");
    return;
  }
  if (!isDirty()) {
    setStatus("There are no staged changes to publish.");
    return;
  }

  const message = elements.commitMessage.value.trim();
  if (!message) {
    setStatus("Enter a commit message.", "warning");
    elements.commitMessage.focus();
    return;
  }

  setBusy("publish");
  setStatus("Checking GitHub for newer changes before publishing…");
  try {
    const data = await authRequest("/api/redirects", {
      method: "PUT",
      headers: { "X-CSRF-Token": state.csrfToken },
      body: JSON.stringify({ redirects: state.redirects, sha: state.sha, message }),
    });
    state.sha = data.sha;
    state.redirects = validateRedirectMap(data.redirects);
    state.baseline = cloneRedirects(state.redirects);
    clearDraft();
    render();
    setStatus("Published successfully. Short links update at the edge within about a minute.", "success");
  } catch (error) {
    console.error("Publish failed.", error);
    if (error.status === 401) {
      state.authenticated = false;
      state.user = null;
      state.csrfToken = "";
      renderConnection();
      setStatus("Your GitHub session expired. Sign in again; the draft is still saved.", "warning");
    } else {
      setStatus(`Publish failed: ${error.message}`, "error");
    }
  } finally {
    setBusy("");
  }
}

function createElement(tagName, className = "", text = "") {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function makeRowButton(label, action, handler) {
  const button = createElement("button", "row-button", label);
  button.type = "button";
  button.dataset.action = action;
  button.addEventListener("click", handler);
  return button;
}

function renderConnection() {
  const connected = state.authenticated && state.user;
  elements.connection.dataset.connected = String(Boolean(connected));
  elements.connectionLabel.textContent = connected ? `@${state.user.login}` : "Read-only";
  elements.accountBadge.dataset.connected = String(Boolean(connected));
  elements.accountBadge.textContent = connected ? "Connected" : "Guest";

  if (connected) {
    elements.identityName.textContent = state.user.name || state.user.login;
    elements.identityDetail.textContent = `@${state.user.login} · secure session`;
    elements.avatarPlaceholder.hidden = true;
    if (state.user.avatarUrl) {
      elements.avatar.src = state.user.avatarUrl;
      elements.avatar.alt = `${state.user.login}'s GitHub avatar`;
      elements.avatar.hidden = false;
    } else {
      elements.avatar.hidden = true;
      elements.avatar.removeAttribute("src");
      elements.avatarPlaceholder.textContent = state.user.login.slice(0, 1).toUpperCase();
      elements.avatarPlaceholder.hidden = false;
    }
  } else {
    elements.identityName.textContent = "Not signed in";
    elements.identityDetail.textContent = "You can browse and stage changes.";
    elements.avatar.hidden = true;
    elements.avatar.removeAttribute("src");
    elements.avatarPlaceholder.textContent = "G";
    elements.avatarPlaceholder.hidden = false;
  }
}

function renderEditor() {
  const editing = Boolean(state.editingKey);
  elements.editorKicker.textContent = editing ? "Edit" : "Create";
  elements.editorTitle.textContent = editing ? "Update this link" : "Stage a short link";
  elements.stageButton.textContent = editing ? "Stage update" : "Stage link";
  elements.cancelEditButton.hidden = !editing;
}

function renderSummary() {
  const staged = changes().length;
  elements.redirectCount.textContent = String(Object.keys(state.redirects).length);
  elements.changeCount.textContent = String(staged);
  elements.publishLabel.textContent =
    staged === 0 ? "Publish changes" : staged === 1 ? "Publish 1 change" : `Publish ${staged} changes`;
}

function renderControls() {
  const busy = Boolean(state.busy);
  elements.loginButton.disabled = busy || state.authenticated;
  elements.logoutButton.disabled = busy || !state.authenticated;
  elements.reloadButton.disabled = busy;
  elements.stageButton.disabled = busy;
  elements.clearButton.disabled = busy;
  elements.cancelEditButton.disabled = busy;
  elements.discardButton.disabled = busy;
  elements.publishButton.disabled = busy || !state.authenticated || !isDirty();
  elements.reloadButton.dataset.loading = String(state.busy === "reload");
  elements.reloadButton.setAttribute("aria-busy", String(state.busy === "reload"));
  elements.publishButton.dataset.loading = String(state.busy === "publish");
  elements.publishButton.setAttribute("aria-busy", String(state.busy === "publish"));
}

function renderList() {
  if (state.loading) return;
  elements.list.replaceChildren();
  const entries = filterRedirects(state.redirects, state.filter);
  const changedByKey = new Map(changes().map((change) => [change.key, change]));

  if (entries.length === 0) {
    const empty = createElement("div", "empty-state");
    const inner = createElement("div", "empty-state-inner");
    inner.append(createElement("div", "empty-mark", state.filter ? "?" : "t·b"));
    inner.append(
      createElement("h3", "", state.filter ? "No matching links" : "No redirects yet"),
      createElement(
        "p",
        "",
        state.filter
          ? "Try another name or destination."
          : "Use the link editor to stage the first one.",
      ),
    );
    empty.append(inner);
    elements.list.append(empty);
    return;
  }

  for (const [key, destination] of entries) {
    const row = createElement("article", "redirect-row");
    const change = changedByKey.get(key);
    if (change) row.dataset.change = change.type;

    const linkCell = createElement("div", "link-cell");
    const monogram = createElement("span", "link-monogram", key.slice(0, 1));
    monogram.setAttribute("aria-hidden", "true");
    const linkCopy = createElement("div", "link-copy");
    const shortLink = createElement("a", "short-link", `${key}.${config.domain}`);
    shortLink.href = `https://${key}.${config.domain}/`;
    shortLink.target = "_blank";
    shortLink.rel = "noopener noreferrer";
    shortLink.title = shortLink.href;
    linkCopy.append(shortLink);
    if (change) linkCopy.append(createElement("span", "row-badge", change.type));
    linkCell.append(monogram, linkCopy);

    const destinationCell = createElement("div", "destination-cell");
    const target = createElement("a", "destination", destination);
    target.href = destination;
    target.target = "_blank";
    target.rel = "noopener noreferrer";
    target.title = destination;
    const destinationHost = createElement("span", "destination-host", new URL(destination).hostname);
    destinationCell.append(target, destinationHost);

    const actions = createElement("div", "row-actions");
    actions.append(
      makeRowButton("Copy", "copy", () => copyShortLink(key)),
      makeRowButton("Edit", "edit", () => startEdit(key)),
      makeRowButton("Remove", "remove", () => removeRedirect(key)),
    );

    row.append(linkCell, destinationCell, actions);
    elements.list.append(row);
  }
}

function renderChanges() {
  const staged = changes();
  elements.changesPanel.hidden = staged.length === 0;
  elements.changeList.replaceChildren();

  for (const change of staged) {
    const item = createElement("div", "change-item");
    const type = createElement("span", "change-type", change.type);
    type.dataset.type = change.type;
    const copy = createElement("div", "change-copy");
    const detail =
      change.type === "added"
        ? change.after
        : change.type === "removed"
          ? `Was ${change.before}`
          : `${change.before} → ${change.after}`;
    copy.append(
      createElement("strong", "", `${change.key}.${config.domain}`),
      createElement("span", "", detail),
    );
    const undo = createElement("button", "text-button", "Undo");
    undo.type = "button";
    undo.addEventListener("click", () => undoChange(change.key));
    item.append(type, copy, undo);
    elements.changeList.append(item);
  }
}

function render() {
  renderConnection();
  renderEditor();
  renderSummary();
  renderList();
  renderChanges();
  renderControls();
}

function consumeAuthResult() {
  const url = new URL(window.location.href);
  const result = url.searchParams.get("auth");
  if (!result) return null;
  url.searchParams.delete("auth");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);

  const messages = {
    success: ["GitHub sign-in completed.", "success"],
    cancelled: ["GitHub sign-in was cancelled.", "warning"],
    account_not_allowed: ["This GitHub account is not allowed to manage t-b.es.", "error"],
    expired_state: ["The sign-in attempt expired. Try again.", "warning"],
    invalid_state: ["The sign-in attempt could not be verified. Try again.", "error"],
    github_authorization_failed: ["GitHub authorization failed. Try again.", "error"],
  };
  return messages[result] || ["GitHub sign-in did not complete.", "warning"];
}

elements.loginButton.addEventListener("click", login);
elements.logoutButton.addEventListener("click", logout);
elements.form.addEventListener("submit", stageRedirect);
elements.clearButton.addEventListener("click", () => cancelEdit());
elements.cancelEditButton.addEventListener("click", () => cancelEdit());
elements.reloadButton.addEventListener("click", reloadRedirects);
elements.publishButton.addEventListener("click", publish);
elements.discardButton.addEventListener("click", discardAll);
elements.search.addEventListener("input", () => {
  state.filter = elements.search.value;
  renderList();
});

window.addEventListener("beforeunload", (event) => {
  if (isDirty() && !state.allowNavigation) {
    event.preventDefault();
    event.returnValue = "";
  }
});

window.addEventListener("keydown", (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key.toLowerCase() === "k") {
    event.preventDefault();
    elements.search.focus();
    elements.search.select();
  }
  if (modifier && event.key.toLowerCase() === "s") {
    event.preventDefault();
    publish();
  }
  if (event.key === "Escape" && state.editingKey) cancelEdit();
});

(async () => {
  const authResult = consumeAuthResult();
  render();
  await checkSession();
  await loadRedirects({ restoreSavedDraft: true });
  if (authResult) setStatus(authResult[0], authResult[1]);
})();
