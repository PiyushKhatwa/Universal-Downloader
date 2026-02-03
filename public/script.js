const DEFAULT_API_ORIGIN = "http://localhost:3000";
const CURRENT_ORIGIN =
    window.location.origin && window.location.origin !== "null"
        ? window.location.origin
        : "";
const API_ORIGIN =
    CURRENT_ORIGIN && window.location.port === "3000"
        ? CURRENT_ORIGIN
        : DEFAULT_API_ORIGIN;
const API = {
    analyze: `${API_ORIGIN}/api/analyze`,
    download: `${API_ORIGIN}/api/download`,
    progress: `${API_ORIGIN}/api/progress`,
};

const ui = {};

const STATES = {
    idle: { key: "idle", label: "Idle" },
    analyzing: { key: "analyzing", label: "Analyzing" },
    ready: { key: "ready", label: "Ready to download" },
    downloading: { key: "downloading", label: "Downloading" },
    completed: { key: "completed", label: "Completed" },
    error: { key: "error", label: "Error" },
};

const appState = {
    title: "download",
    formats: [],
    selectedFormat: null,
    progressSource: null,
    downloadId: null,
    optionNodes: new Map(),
    activeQuality: null,
    state: STATES.idle,
};

function initUi() {
    ui.linkInput = document.getElementById("link");
    ui.analyzeBtn = document.getElementById("analyzeBtn");
    ui.stateBadge = document.getElementById("state");
    ui.stateLabel = document.getElementById("stateLabel");
    ui.stateSpinner = document.getElementById("stateSpinner");
    ui.errorBox = document.getElementById("error");
    ui.successBox = document.getElementById("success");
    ui.formatsSection = document.getElementById("formatsSection");
    ui.formatOptions = document.getElementById("formatOptions");
    ui.qualityBar = document.getElementById("qualityBar");
    ui.qualityButtons = document.getElementById("qualityButtons");
    ui.downloadSection = document.getElementById("downloadSection");
    ui.pickFolderBtn = document.getElementById("pickFolderBtn");
    ui.folderHint = document.getElementById("folderHint");
    ui.downloadBtn = document.getElementById("downloadBtn");
    ui.progressSection = document.getElementById("progressSection");
    ui.progressFill = document.getElementById("progressFill");
    ui.progressPercent = document.getElementById("progressPercent");
    ui.progressSpeed = document.getElementById("progressSpeed");
    ui.progressEta = document.getElementById("progressEta");
    ui.progressStatus = document.getElementById("progressStatus");
    ui.logBox = document.getElementById("log");
}

function setUiState(state) {
    if (ui.stateLabel) ui.stateLabel.textContent = state.label;
    if (ui.stateBadge) ui.stateBadge.dataset.state = state.key;
    if (ui.stateSpinner) {
        if (ui.stateBadge) {
            const extraSpinners = ui.stateBadge.querySelectorAll(".spinner");
            extraSpinners.forEach((node) => {
                if (node !== ui.stateSpinner) node.remove();
            });
        }
        ui.stateSpinner.classList.toggle("hidden", state.key !== STATES.analyzing.key);
    }
}

function setState(state) {
    appState.state = state;
    setUiState(state);
}

function setError(message) {
    if (!ui.errorBox) return;
    if (!message) {
        ui.errorBox.classList.add("hidden");
        ui.errorBox.textContent = "";
        return;
    }
    setSuccess("");
    ui.errorBox.textContent = message;
    ui.errorBox.classList.remove("hidden");
}

function setSuccess(message) {
    if (!ui.successBox) return;
    if (!message) {
        ui.successBox.classList.add("hidden");
        ui.successBox.textContent = "";
        return;
    }
    ui.successBox.textContent = message;
    ui.successBox.classList.remove("hidden");
}

function setControlsDisabled(disabled) {
    if (ui.linkInput) ui.linkInput.disabled = disabled;
    if (ui.analyzeBtn) ui.analyzeBtn.disabled = disabled;
    if (ui.pickFolderBtn) ui.pickFolderBtn.disabled = disabled;
    if (ui.downloadBtn) ui.downloadBtn.disabled = disabled || !appState.selectedFormat;
    if (ui.formatOptions) {
        const inputs = ui.formatOptions.querySelectorAll("input[type='radio']");
        inputs.forEach((input) => {
            input.disabled = disabled;
        });
    }
    if (ui.qualityButtons) {
        const qualityButtons = ui.qualityButtons.querySelectorAll("button");
        qualityButtons.forEach((button) => {
            button.disabled = disabled;
        });
    }
}

function resetFormats() {
    if (ui.formatOptions) ui.formatOptions.innerHTML = "";
    if (ui.qualityButtons) ui.qualityButtons.innerHTML = "";
    if (ui.qualityBar) ui.qualityBar.classList.add("hidden");
    if (ui.formatsSection) ui.formatsSection.classList.add("hidden");
    if (ui.downloadSection) ui.downloadSection.classList.add("hidden");
    appState.selectedFormat = null;
    appState.optionNodes.clear();
    appState.activeQuality = null;
    if (ui.downloadBtn) ui.downloadBtn.disabled = true;
}

function resetProgress() {
    if (ui.progressFill) ui.progressFill.style.width = "0%";
    if (ui.progressPercent) ui.progressPercent.textContent = "0%";
    if (ui.progressSpeed) ui.progressSpeed.textContent = "-";
    if (ui.progressEta) ui.progressEta.textContent = "ETA --:--";
    if (ui.progressStatus) ui.progressStatus.textContent = "Idle";
}

function formatBytes(bytes) {
    if (!bytes || !Number.isFinite(bytes)) return null;
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }
    return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function createFormatOption(entry, kind) {
    const kindLabel = {
        combined: "Video + Audio",
        "video-only": "Video only",
        audio: "Audio only",
    }[kind];

    const isAudio = kind === "audio";
    const resolution = isAudio
        ? (entry.abr ? `${Math.round(entry.abr)}kbps` : entry.resolution)
        : entry.resolution;
    const ext = isAudio ? "mp3" : entry.ext;
    const size = formatBytes(entry.filesize);

    const title = `${kindLabel} - ${resolution} - ${ext.toUpperCase()}`;
    const meta = [];
    if (size) meta.push(`Size ${size}`);
    if (!isAudio && entry.fps) meta.push(`${entry.fps}fps`);
    if (entry.formatNote) meta.push(entry.formatNote);

    return {
        id: entry.id,
        kind,
        ext,
        height: entry.height || null,
        abr: entry.abr || null,
        title,
        subtitle: meta.join(" - ") || " ",
    };
}

const QUALITY_PRESETS = [
    { key: "144p", label: "144p", height: 144 },
    { key: "360p", label: "360p", height: 360 },
    { key: "720p", label: "720p", height: 720 },
    { key: "1080p", label: "1080p", height: 1080 },
    { key: "audio", label: "Audio only", kind: "audio" },
];

function setActiveQuality(key) {
    appState.activeQuality = key;
    if (ui.qualityButtons) {
        const buttons = ui.qualityButtons.querySelectorAll("button");
        buttons.forEach((button) => {
            button.classList.toggle("active", button.dataset.quality === key);
        });
    }
}

function selectFormatOption(option) {
    if (!option) return;
    const node = appState.optionNodes.get(option.id);
    if (node) {
        node.checked = true;
    }
    appState.selectedFormat = option;
    if (ui.downloadBtn) ui.downloadBtn.disabled = false;
}

function pickBestVideo(options, height) {
    const candidates = options.filter((option) => option.height);
    if (!candidates.length) return null;

    const exact = candidates.find((option) => option.height === height);
    if (exact) return exact;

    const below = candidates
        .filter((option) => option.height < height)
        .sort((a, b) => b.height - a.height)[0];
    if (below) return below;

    return candidates.sort((a, b) => a.height - b.height)[0];
}

function renderQualityButtons(options) {
    if (!ui.qualityButtons || !ui.qualityBar) return;
    ui.qualityButtons.innerHTML = "";
    const fragment = document.createDocumentFragment();
    QUALITY_PRESETS.forEach((preset) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "quality-button";
        button.textContent = preset.label;
        button.dataset.quality = preset.key;
        button.addEventListener("click", () => {
            setActiveQuality(preset.key);
            if (preset.kind === "audio") {
                const audioOptions = options.filter((option) => option.kind === "audio");
                const bestAudio = audioOptions.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
                selectFormatOption(bestAudio);
                return;
            }
            const combined = options.filter((option) => option.kind === "combined");
            const videoOnly = options.filter((option) => option.kind === "video-only");
            const bestCombined = pickBestVideo(combined, preset.height);
            const bestVideo = pickBestVideo(videoOnly, preset.height);
            selectFormatOption(bestCombined || bestVideo);
        });
        fragment.append(button);
    });
    ui.qualityButtons.append(fragment);
    ui.qualityBar.classList.remove("hidden");
}

function renderGroup(title, options) {
    if (!options.length) return null;
    if (!ui.formatOptions) return null;
    const wrapper = document.createElement("div");
    const heading = document.createElement("div");
    heading.className = "group-title";
    heading.textContent = `${title} (${options.length})`;
    const group = document.createElement("div");
    group.className = "group";

    options.forEach((option) => {
        const label = document.createElement("label");
        label.className = "option";

        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "format";
        radio.value = option.id;
        radio.addEventListener("change", () => {
            setActiveQuality(null);
            appState.selectedFormat = option;
            if (ui.downloadBtn) ui.downloadBtn.disabled = false;
        });
        appState.optionNodes.set(option.id, radio);

        const details = document.createElement("div");
        const titleNode = document.createElement("div");
        const subtitle = document.createElement("div");
        titleNode.className = "option-title";
        subtitle.className = "option-sub";
        titleNode.textContent = option.title;
        subtitle.textContent = option.subtitle;
        details.append(titleNode, subtitle);

        label.append(radio, details);
        group.append(label);
    });

    wrapper.append(heading, group);
    return wrapper;
}

function renderFormats(formats) {
    resetFormats();
    const options = [];

    formats.combined.forEach((entry) => options.push(createFormatOption(entry, "combined")));
    formats.videoOnly.forEach((entry) => options.push(createFormatOption(entry, "video-only")));
    formats.audioOnly.forEach((entry) => options.push(createFormatOption(entry, "audio")));

    if (!options.length) {
        setError("No downloadable formats found for this link.");
        return false;
    }

    renderQualityButtons(options);

    const fragment = document.createDocumentFragment();
    const combinedGroup = renderGroup("Video + Audio", options.filter((o) => o.kind === "combined"));
    const videoGroup = renderGroup("Video only", options.filter((o) => o.kind === "video-only"));
    const audioGroup = renderGroup("Audio only", options.filter((o) => o.kind === "audio"));
    [combinedGroup, videoGroup, audioGroup].forEach((group) => {
        if (group) fragment.append(group);
    });

    if (ui.formatOptions) ui.formatOptions.append(fragment);
    if (ui.formatsSection) ui.formatsSection.classList.remove("hidden");
    if (ui.downloadSection) ui.downloadSection.classList.remove("hidden");
    return true;
}

async function handleAnalyze() {
    if (!ui.linkInput) return;
    const url = ui.linkInput.value.trim();
    if (!url) {
        setError("Please paste a valid URL first.");
        return;
    }

    setError("");
    setSuccess("");
    resetFormats();
    resetProgress();
    if (ui.progressSection) ui.progressSection.classList.add("hidden");
    setState(STATES.analyzing);
    setControlsDisabled(true);

    try {
        const res = await fetch(API.analyze, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
        });

        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
            throw new Error("Server returned non-JSON response. Check the backend server.");
        }
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.error || "Failed to analyze the link.");
        }

        appState.title = data.title || "download";
        appState.formats = data.formats || { combined: [], videoOnly: [], audioOnly: [] };
        const hasFormats = renderFormats(appState.formats);
        setState(hasFormats ? STATES.ready : STATES.idle);
    } catch (err) {
        setError(err.message);
        setState(STATES.error);
    } finally {
        setControlsDisabled(false);
    }
}

function updateProgress(payload) {
    if (payload.type === "error") {
        setError(payload.message || "Download failed.");
        setState(STATES.error);
        setControlsDisabled(false);
    if (ui.progressSection) ui.progressSection.classList.add("hidden");
        if (appState.progressSource) {
            appState.progressSource.close();
        }
        return;
    }

    if (payload.status) {
    if (ui.progressStatus) ui.progressStatus.textContent = payload.status;
        if (payload.status === "Completed") {
            setState(STATES.completed);
            setControlsDisabled(false);
            setSuccess("Download completed successfully.");
            if (appState.progressSource) {
                appState.progressSource.close();
                appState.progressSource = null;
            }
        }
    }
    if (payload.speed) {
        if (ui.progressSpeed) ui.progressSpeed.textContent = payload.speed;
    }
    if (payload.eta) {
        if (ui.progressEta) ui.progressEta.textContent = `ETA ${payload.eta}`;
    }
    if (payload.percent !== undefined) {
        const percent = Math.min(100, Math.max(0, payload.percent));
        if (ui.progressPercent) ui.progressPercent.textContent = `${percent.toFixed(1)}%`;
        if (ui.progressFill) ui.progressFill.style.width = `${percent}%`;
    }
}

function startProgressStream(downloadId) {
    if (!("EventSource" in window)) return null;
    const source = new EventSource(`${API.progress}/${downloadId}`);
    source.onmessage = (event) => {
        try {
            const payload = JSON.parse(event.data);
            updateProgress(payload);
        } catch {
            return;
        }
    };
    source.onerror = () => {};
    return source;
}

function submitDownloadForm(payload) {
    let iframe = document.getElementById("downloadFrame");
    if (!iframe) {
        iframe = document.createElement("iframe");
        iframe.id = "downloadFrame";
        iframe.name = "downloadFrame";
        iframe.className = "hidden";
        document.body.append(iframe);
    }

    const form = document.createElement("form");
    form.method = "POST";
    form.action = API.download;
    form.target = "downloadFrame";
    form.className = "hidden";

    Object.entries(payload).forEach(([key, value]) => {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = key;
        input.value = value;
        form.append(input);
    });

    document.body.append(form);
    form.submit();
    form.remove();
}

async function handleDownload() {
    if (!ui.linkInput) return;
    if (!appState.selectedFormat) {
        setError("Please select a quality before downloading.");
        return;
    }

    const url = ui.linkInput.value.trim();
    if (!url) {
        setError("Please paste a valid URL first.");
        return;
    }

    setError("");
    setSuccess("");
    resetProgress();
    if (ui.progressSection) ui.progressSection.classList.remove("hidden");
    setState(STATES.downloading);
    setControlsDisabled(true);

    const downloadId = crypto.randomUUID ? crypto.randomUUID() : `dl-${Date.now()}`;
    appState.downloadId = downloadId;
    appState.progressSource = startProgressStream(downloadId);

    submitDownloadForm({
        url,
        formatId: appState.selectedFormat.id,
        kind: appState.selectedFormat.kind,
        title: appState.title,
        downloadId,
    });
}

async function handlePickFolder() {
    if (ui.folderHint) {
        ui.folderHint.textContent =
            "Downloads use your browser settings. Enable the save dialog to choose a folder.";
    }
}

document.addEventListener("DOMContentLoaded", () => {
    initUi();
    if (ui.analyzeBtn) ui.analyzeBtn.addEventListener("click", handleAnalyze);
    if (ui.downloadBtn) ui.downloadBtn.addEventListener("click", handleDownload);
    if (ui.pickFolderBtn) ui.pickFolderBtn.addEventListener("click", handlePickFolder);
    if (ui.linkInput) {
        ui.linkInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                handleAnalyze();
            }
        });
    }
    setState(STATES.idle);
});
