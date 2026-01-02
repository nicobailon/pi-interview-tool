(() => {
  const data = window.__INTERVIEW_DATA__ || {};
  const questions = Array.isArray(data.questions) ? data.questions : [];
  const sessionToken = data.sessionToken || "";
  const timeout = typeof data.timeout === "number" ? data.timeout : 0;

  const titleEl = document.getElementById("form-title");
  const descriptionEl = document.getElementById("form-description");
  const containerEl = document.getElementById("questions-container");
  const formEl = document.getElementById("interview-form");
  
  const submitBtn = document.getElementById("submit-btn");
  const errorContainer = document.getElementById("error-container");
  const successOverlay = document.getElementById("success-overlay");
  const expiredOverlay = document.getElementById("expired-overlay");
  const closeTabBtn = document.getElementById("close-tab-btn");
  const countdownBadge = document.getElementById("countdown-badge");
  const countdownValue = countdownBadge?.querySelector(".countdown-value");
  const countdownRingProgress = countdownBadge?.querySelector(".countdown-ring-progress");
  const closeCountdown = document.getElementById("close-countdown");
  const stayBtn = document.getElementById("stay-btn");

  const MAX_SIZE = 5 * 1024 * 1024;
  const MAX_DIMENSION = 4096;
  const MAX_IMAGES = 12;
  const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

  const imageState = new Map();
  const imagePathState = new Map();
  const attachState = new Map();
  const attachPathState = new Map();
  let storageKey = null;
  let saveTimer = null;
  let sessionExpired = false;
  let countdownInterval = null;
  let filePickerOpen = false;
  let countdownEndTime = 0;
  let expirationTimeout = null;
  let tickLoopRunning = false;
  const CLOSE_DELAY = 10;
  const RING_CIRCUMFERENCE = 100.53;

  function updateCountdownBadge(secondsLeft, totalSeconds) {
    if (!countdownBadge || !countdownValue || !countdownRingProgress) return;
    
    countdownValue.textContent = formatTime(secondsLeft);
    const progress = (totalSeconds - secondsLeft) / totalSeconds;
    countdownRingProgress.style.strokeDashoffset = RING_CIRCUMFERENCE * progress;
  }

  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins > 0) {
      return `${mins}:${secs.toString().padStart(2, "0")}`;
    }
    return String(secs);
  }

  function startCountdownDisplay() {
    if (!countdownBadge || timeout <= 0) return;
    
    const urgentThreshold = 30;
    countdownEndTime = Date.now() + (timeout * 1000);
    
    countdownBadge.classList.remove("hidden");
    
    if (tickLoopRunning) return;
    tickLoopRunning = true;
    
    const tick = () => {
      const now = Date.now();
      const remaining = Math.max(0, Math.ceil((countdownEndTime - now) / 1000));
      
      updateCountdownBadge(remaining, timeout);
      
      if (remaining <= urgentThreshold) {
        countdownBadge.classList.add("urgent");
      } else {
        countdownBadge.classList.remove("urgent");
      }
      
      if (remaining > 0 && !sessionExpired) {
        requestAnimationFrame(tick);
      } else {
        tickLoopRunning = false;
      }
    };
    
    requestAnimationFrame(tick);
  }

  function refreshCountdown() {
    if (sessionExpired || timeout <= 0) return;
    countdownEndTime = Date.now() + (timeout * 1000);
    countdownBadge?.classList.remove("urgent");
    
    if (expirationTimeout) {
      clearTimeout(expirationTimeout);
    }
    expirationTimeout = setTimeout(() => {
      showSessionExpired();
    }, timeout * 1000);
  }

  function showSessionExpired() {
    if (sessionExpired) return;
    sessionExpired = true;
    tickLoopRunning = false;
    
    submitBtn.disabled = true;
    countdownBadge?.classList.add("hidden");
    
    expiredOverlay.classList.remove("hidden");
    requestAnimationFrame(() => {
      expiredOverlay.classList.add("visible");
      stayBtn.focus();
    });
    
    let closeIn = CLOSE_DELAY;
    if (closeCountdown) closeCountdown.textContent = closeIn;
    
    countdownInterval = setInterval(() => {
      closeIn--;
      if (closeCountdown) closeCountdown.textContent = closeIn;
      
      if (closeIn <= 0) {
        clearInterval(countdownInterval);
        window.close();
      }
    }, 1000);
  }

  function isNetworkError(err) {
    if (err instanceof TypeError) return true;
    if (err.name === "TypeError") return true;
    const msg = String(err.message || "").toLowerCase();
    return msg.includes("fetch") || msg.includes("network") || msg.includes("failed to fetch");
  }

  function escapeSelector(value) {
    if (window.CSS && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function setText(el, text) {
    if (!el) return;
    el.textContent = text || "";
  }

  function debounceSave() {
    if (saveTimer) {
      window.clearTimeout(saveTimer);
    }
    saveTimer = window.setTimeout(() => {
      saveProgress();
    }, 500);
  }

  function updateDoneState(questionId) {
    const doneItem = document.querySelector(`[data-done-for="${escapeSelector(questionId)}"]`);
    if (!doneItem) return;
    const hasSelection = document.querySelectorAll(`input[name="${escapeSelector(questionId)}"]:checked`).length > 0;
    doneItem.classList.toggle("disabled", !hasSelection);
  }

  function addImagePath(questionId, path) {
    const paths = imagePathState.get(questionId) || [];
    if (!paths.includes(path)) {
      paths.push(path);
      imagePathState.set(questionId, paths);
      renderSelectedItems(questionId);
      debounceSave();
    }
  }

  function removeImagePath(questionId, path) {
    const paths = imagePathState.get(questionId) || [];
    const index = paths.indexOf(path);
    if (index > -1) {
      paths.splice(index, 1);
      imagePathState.set(questionId, paths);
      renderSelectedItems(questionId);
      debounceSave();
    }
  }

  function renderSelectedItems(questionId) {
    const container = document.querySelector(`[data-selected-for="${escapeSelector(questionId)}"]`);
    if (!container) return;
    container.innerHTML = "";
    
    const imageEntry = imageState.get(questionId);
    if (imageEntry) {
      const item = document.createElement("div");
      item.className = "selected-item selected-image";
      
      const img = document.createElement("img");
      const url = URL.createObjectURL(imageEntry.file);
      img.src = url;
      img.onload = () => URL.revokeObjectURL(url);
      
      const name = document.createElement("span");
      name.className = "selected-item-name";
      name.textContent = imageEntry.file.name;
      
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "selected-item-remove";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => {
        imageState.delete(questionId);
        renderSelectedItems(questionId);
        debounceSave();
      });
      
      item.appendChild(img);
      item.appendChild(name);
      item.appendChild(removeBtn);
      container.appendChild(item);
    }
    
    const paths = imagePathState.get(questionId) || [];
    paths.forEach(path => {
      const item = document.createElement("div");
      item.className = "selected-item selected-path";
      
      const pathText = document.createElement("span");
      pathText.className = "selected-item-path";
      pathText.textContent = path;
      
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "selected-item-remove";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => removeImagePath(questionId, path));
      
      item.appendChild(pathText);
      item.appendChild(removeBtn);
      container.appendChild(item);
    });
  }

  function clearGlobalError() {
    if (!errorContainer) return;
    errorContainer.textContent = "";
    errorContainer.classList.add("hidden");
  }

  function showGlobalError(message) {
    if (!errorContainer) return;
    errorContainer.textContent = message;
    errorContainer.classList.remove("hidden");
  }

  function setFieldError(id, message) {
    const field = document.querySelector(`[data-error-for="${escapeSelector(id)}"]`);
    if (!field) return;
    field.textContent = message || "";
  }

  function clearFieldErrors() {
    const fields = document.querySelectorAll(".field-error");
    fields.forEach((el) => {
      el.textContent = "";
    });
  }

  let currentQuestionIndex = 0;
  let currentOptionIndex = 0;
  let questionCards = [];
  let inSubmitArea = false;
  const formFooter = document.querySelector('.form-footer');

  function getOptionsForCard(card) {
    const inputs = Array.from(card.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
    const dropzone = card.querySelector('.file-dropzone');
    const pathInput = card.querySelector('.image-path-input');
    const doneItem = card.querySelector('.done-item');
    
    const items = [...inputs];
    if (dropzone) items.push(dropzone);
    if (pathInput) items.push(pathInput);
    if (doneItem) items.push(doneItem);
    
    return items;
  }

  function isPathInput(el) {
    return el && (el.classList.contains('image-path-input') || el.classList.contains('attach-inline-path'));
  }

  function isDropzone(el) {
    return el && el.classList.contains('file-dropzone');
  }

  function isOptionInput(el) {
    return el && (el.type === 'radio' || el.type === 'checkbox');
  }

  function isDoneItem(el) {
    return el && el.classList.contains('done-item');
  }

  function highlightOption(card, optionIndex) {
    const options = getOptionsForCard(card);
    options.forEach((opt, i) => {
      const item = isOptionInput(opt) ? opt.closest('.option-item') : opt;
      item?.classList.toggle('focused', i === optionIndex);
    });
    const current = options[optionIndex];
    if (current) {
      current.focus();
    }
  }

  function clearOptionHighlight(card) {
    card.querySelectorAll('.option-item, .done-item, .file-dropzone, .image-path-input').forEach(item => {
      item.classList.remove('focused');
    });
  }

  function focusQuestion(index, fromDirection = 'next') {
    if (index < 0 || index >= questionCards.length) return;
    
    deactivateSubmitArea();
    
    const prevCard = questionCards[currentQuestionIndex];
    if (prevCard) {
      prevCard.classList.remove('active');
      clearOptionHighlight(prevCard);
    }
    
    currentQuestionIndex = index;
    const card = questionCards[index];
    card.classList.add('active');
    card.scrollIntoView({ behavior: 'auto', block: 'center' });
    
    const options = getOptionsForCard(card);
    const dropzone = card.querySelector('.file-dropzone');
    const textarea = card.querySelector('textarea');
    
    if (dropzone) {
      currentOptionIndex = 0;
      highlightOption(card, currentOptionIndex);
    } else if (options.length > 0) {
      currentOptionIndex = fromDirection === 'prev' ? options.length - 1 : 0;
      highlightOption(card, currentOptionIndex);
    } else if (textarea) {
      textarea.focus();
      if (fromDirection === 'prev') {
        textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      }
    }
  }

  function nextQuestion() {
    if (currentQuestionIndex < questionCards.length - 1) {
      focusQuestion(currentQuestionIndex + 1, 'next');
    } else {
      activateSubmitArea();
    }
  }

  function activateSubmitArea() {
    const prevCard = questionCards[currentQuestionIndex];
    if (prevCard) {
      prevCard.classList.remove('active');
      clearOptionHighlight(prevCard);
    }
    inSubmitArea = true;
    formFooter?.classList.add('active');
    submitBtn.focus();
    formFooter?.scrollIntoView({ behavior: 'auto', block: 'center' });
  }

  function deactivateSubmitArea() {
    inSubmitArea = false;
    formFooter?.classList.remove('active');
  }

  function prevQuestion() {
    if (currentQuestionIndex > 0) {
      focusQuestion(currentQuestionIndex - 1, 'prev');
    }
  }

  function handleQuestionKeydown(event) {
    if (inSubmitArea) return;
    
    const card = questionCards[currentQuestionIndex];
    if (!card) return;
    
    const options = getOptionsForCard(card);
    const textarea = card.querySelector('textarea');
    const fileInput = card.querySelector('input[type="file"]');
    const isTextFocused = document.activeElement === textarea;
    
    if (event.key === 'Tab') {
      const inAttachArea = document.activeElement?.closest('.attach-inline');
      if (inAttachArea) return;
      
      event.preventDefault();
      const options = getOptionsForCard(card);
      
      if (options.length > 0) {
        if (event.shiftKey) {
          currentOptionIndex = (currentOptionIndex - 1 + options.length) % options.length;
        } else {
          currentOptionIndex = (currentOptionIndex + 1) % options.length;
        }
        highlightOption(card, currentOptionIndex);
      }
      return;
    }
    
    if (event.key === 'Escape') {
      if (!expiredOverlay.classList.contains('hidden')) {
        if (countdownInterval) clearInterval(countdownInterval);
        window.close();
        return;
      }
      showSessionExpired();
      return;
    }
    
    const isMeta = event.metaKey || event.ctrlKey;
    if (event.key === 'Enter' && isMeta) {
      event.preventDefault();
      formEl.requestSubmit();
      return;
    }
    
    if (event.key === 'a' && !isMeta && !event.shiftKey && !isTextFocused) {
      event.preventDefault();
      const attachBtn = card.querySelector('.attach-btn');
      if (attachBtn) {
        const attachInline = card.querySelector('.attach-inline');
        const wasHidden = attachInline?.classList.contains('hidden');
        attachBtn.click();
        if (wasHidden && attachInline && !attachInline.classList.contains('hidden')) {
          const attachDrop = attachInline.querySelector('.attach-inline-drop');
          if (attachDrop) attachDrop.focus();
        } else {
          attachBtn.focus();
        }
      }
      return;
    }
    
    if (event.key === 'ArrowLeft') {
      if (document.activeElement === textarea || isPathInput(document.activeElement)) {
        return;
      }
      event.preventDefault();
      prevQuestion();
      return;
    }
    
    if (event.key === 'ArrowRight') {
      if (document.activeElement === textarea || isPathInput(document.activeElement)) {
        return;
      }
      event.preventDefault();
      nextQuestion();
      return;
    }
    
    if (options.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        currentOptionIndex = (currentOptionIndex + 1) % options.length;
        highlightOption(card, currentOptionIndex);
        return;
      }
      
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        currentOptionIndex = (currentOptionIndex - 1 + options.length) % options.length;
        highlightOption(card, currentOptionIndex);
        return;
      }
      
      if (event.key === 'Enter' || event.key === ' ') {
        if (isPathInput(document.activeElement)) {
          return;
        }
        if (document.activeElement?.closest('.attach-inline')) {
          return;
        }
        event.preventDefault();
        const option = options[currentOptionIndex];
        if (option) {
          if (isDoneItem(option)) {
            if (!option.classList.contains('disabled')) {
              nextQuestion();
            }
          } else if (isDropzone(option)) {
            if (!filePickerOpen) {
              filePickerOpen = true;
              const fileInput = card.querySelector('input[type="file"]');
              if (fileInput) fileInput.click();
            }
          } else if (option.type === 'radio') {
            option.checked = true;
            debounceSave();
            nextQuestion();
          } else if (option.type === 'checkbox') {
            option.checked = !option.checked;
            debounceSave();
            const questionId = option.name;
            updateDoneState(questionId);
          }
        }
        return;
      }
    }
    
    if (textarea && !isTextFocused) {
      if (event.key === 'Enter') {
        event.preventDefault();
        textarea.focus();
        return;
      }
    }
    
    if (isTextFocused && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      nextQuestion();
      return;
    }
    
    if (fileInput && document.activeElement === fileInput) {
      if (event.key === 'Enter' || event.key === ' ') {
        return;
      }
    }
  }

  function initQuestionNavigation() {
    questionCards = Array.from(containerEl.querySelectorAll('.question-card'));
    
    questionCards.forEach((card, index) => {
      card.setAttribute('tabindex', '0');
      card.addEventListener('focus', () => {
        if (currentQuestionIndex !== index) {
          focusQuestion(index);
        }
      });
      card.addEventListener('click', (e) => {
        if (e.target.closest('.option-item')) return;
        if (currentQuestionIndex !== index) {
          focusQuestion(index);
        }
      });
    });
    
    containerEl.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach(input => {
      input.setAttribute('tabindex', '-1');
    });
    
    document.addEventListener('keydown', handleQuestionKeydown);
    
    if (questionCards.length > 0) {
      setTimeout(() => focusQuestion(0), 100);
    }
  }

  function createQuestionCard(question, index) {
    const card = document.createElement("section");
    card.className = "question-card";
    card.setAttribute("role", "listitem");
    card.dataset.questionId = question.id;

    const title = document.createElement("h2");
    title.className = "question-title";
    title.id = `q-${question.id}-title`;
    title.textContent = `${index + 1}. ${question.question}`;
    card.appendChild(title);

    if (question.context) {
      const context = document.createElement("p");
      context.className = "question-context";
      context.textContent = question.context;
      card.appendChild(context);
    }

    if (question.type === "single" || question.type === "multi") {
      const list = document.createElement("div");
      list.className = "option-list";
      list.setAttribute("role", question.type === "single" ? "radiogroup" : "group");
      list.setAttribute("aria-labelledby", title.id);

      const recommended = question.recommended;
      const recommendedList = Array.isArray(recommended)
        ? recommended
        : recommended
          ? [recommended]
          : [];

      question.options.forEach((option, optionIndex) => {
        const label = document.createElement("label");
        label.className = "option-item";

        const input = document.createElement("input");
        input.type = question.type === "single" ? "radio" : "checkbox";
        input.name = question.id;
        input.value = option;
        input.id = `q-${question.id}-${optionIndex}`;

        input.addEventListener("change", () => {
          debounceSave();
          if (question.type === "multi") {
            updateDoneState(question.id);
          }
        });

        const text = document.createElement("span");
        text.textContent = option;
        
        if (recommendedList.includes(option)) {
          const star = document.createElement("span");
          star.className = "recommended-star";
          star.textContent = "*";
          text.appendChild(star);
        }

        label.appendChild(input);
        label.appendChild(text);
        list.appendChild(label);
      });

      if (question.type === "multi") {
        const doneItem = document.createElement("div");
        doneItem.className = "option-item done-item disabled";
        doneItem.setAttribute("tabindex", "0");
        doneItem.dataset.doneFor = question.id;
        doneItem.innerHTML = '<span class="done-check">✓</span><span>Done</span>';
        doneItem.addEventListener("click", () => {
          if (!doneItem.classList.contains("disabled")) {
            nextQuestion();
          }
        });
        doneItem.addEventListener("keydown", (e) => {
          if ((e.key === "Enter" || e.key === " ") && !doneItem.classList.contains("disabled")) {
            e.preventDefault();
            e.stopPropagation();
            nextQuestion();
          }
        });
        list.appendChild(doneItem);
      }

      card.appendChild(list);
    }

    if (question.type === "text") {
      const textarea = document.createElement("textarea");
      textarea.dataset.questionId = question.id;
      textarea.addEventListener("input", debounceSave);
      textarea.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight" && textarea.selectionStart === textarea.value.length) {
          e.preventDefault();
          e.stopPropagation();
          nextQuestion();
        }
        if (e.key === "ArrowLeft" && textarea.selectionStart === 0) {
          e.preventDefault();
          e.stopPropagation();
          prevQuestion();
        }
      });
      card.appendChild(textarea);
    }

    if (question.type === "image") {
      imagePathState.set(question.id, []);
      
      const wrapper = document.createElement("div");
      wrapper.className = "file-input";

      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png,image/jpeg,image/gif,image/webp";
      input.dataset.questionId = question.id;

      input.addEventListener("change", () => {
        setTimeout(() => { filePickerOpen = false; }, 200);
        handleImageChange(question.id, input);
      });
      input.addEventListener("cancel", () => {
        setTimeout(() => { filePickerOpen = false; }, 200);
      });
      input.addEventListener("blur", () => {
        setTimeout(() => { filePickerOpen = false; }, 500);
      });

      const dropzone = document.createElement("div");
      dropzone.className = "file-dropzone";
      dropzone.setAttribute("tabindex", "0");
      dropzone.innerHTML = `
        <span class="file-dropzone-icon">+</span>
        <span class="file-dropzone-text">Click to upload</span>
        <span class="file-dropzone-hint">PNG, JPG, GIF, WebP (max 5MB)</span>
      `;
      
      const pathInput = document.createElement("input");
      pathInput.type = "text";
      pathInput.className = "image-path-input";
      pathInput.placeholder = "Or paste image path/URL and press Enter...";
      pathInput.dataset.questionId = question.id;
      pathInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && pathInput.value.trim()) {
          e.preventDefault();
          e.stopPropagation();
          addImagePath(question.id, pathInput.value.trim());
          pathInput.value = "";
        }
        if (e.key === "ArrowRight" && pathInput.selectionStart === pathInput.value.length) {
          e.preventDefault();
          e.stopPropagation();
          nextQuestion();
        }
        if (e.key === "ArrowLeft" && pathInput.selectionStart === 0) {
          e.preventDefault();
          e.stopPropagation();
          prevQuestion();
        }
      });
      
      const selectedItems = document.createElement("div");
      selectedItems.className = "image-selected-items";
      selectedItems.dataset.selectedFor = question.id;
      dropzone.addEventListener("click", () => {
        if (!filePickerOpen) {
          filePickerOpen = true;
          input.click();
        }
      });
      dropzone.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          if (!filePickerOpen) {
            filePickerOpen = true;
            input.click();
          }
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          nextQuestion();
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          e.stopPropagation();
          prevQuestion();
        }
      });
      
      dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropzone.classList.add("dragover");
      });
      dropzone.addEventListener("dragleave", (e) => {
        e.preventDefault();
        dropzone.classList.remove("dragover");
      });
      dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropzone.classList.remove("dragover");
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
          const dt = new DataTransfer();
          dt.items.add(files[0]);
          input.files = dt.files;
          input.dispatchEvent(new Event("change"));
        }
      });

      wrapper.appendChild(input);
      wrapper.appendChild(dropzone);
      wrapper.appendChild(pathInput);
      wrapper.appendChild(selectedItems);
      card.appendChild(wrapper);
    }

    if (question.type !== "image") {
      attachPathState.set(question.id, []);
      
      const attachHint = document.createElement("div");
      attachHint.className = "attach-hint";
      
      const attachBtn = document.createElement("button");
      attachBtn.type = "button";
      attachBtn.className = "attach-btn";
      attachBtn.innerHTML = '<span>+</span> attach';
      attachBtn.dataset.questionId = question.id;
      
      const attachInline = document.createElement("div");
      attachInline.className = "attach-inline hidden";
      attachInline.dataset.attachInlineFor = question.id;
      
      const attachFileInput = document.createElement("input");
      attachFileInput.type = "file";
      attachFileInput.accept = "image/png,image/jpeg,image/gif,image/webp";
      attachFileInput.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;";
      
      const attachDrop = document.createElement("div");
      attachDrop.className = "attach-inline-drop";
      attachDrop.setAttribute("tabindex", "0");
      attachDrop.textContent = "Drop image or click";
      
      const attachPath = document.createElement("input");
      attachPath.type = "text";
      attachPath.className = "attach-inline-path";
      attachPath.placeholder = "Or paste path/URL and press Enter";
      
      const attachItems = document.createElement("div");
      attachItems.className = "attach-inline-items";
      attachItems.dataset.attachItemsFor = question.id;
      
      attachBtn.addEventListener("click", () => {
        const isHidden = attachInline.classList.contains("hidden");
        attachInline.classList.toggle("hidden", !isHidden);
        if (isHidden) attachDrop.focus();
      });
      
      attachFileInput.addEventListener("change", () => {
        setTimeout(() => { filePickerOpen = false; }, 200);
        handleAttachChange(question.id, attachFileInput, attachBtn);
      });
      
      attachDrop.addEventListener("click", () => {
        if (!filePickerOpen) {
          filePickerOpen = true;
          attachFileInput.click();
        }
      });
      attachDrop.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!filePickerOpen) {
            filePickerOpen = true;
            attachFileInput.click();
          }
        }
        if (e.key === "Tab") {
          e.preventDefault();
          if (e.shiftKey) {
            attachBtn.focus();
          } else {
            attachPath.focus();
          }
        }
        if (e.key === "Escape") {
          attachBtn.click();
          attachBtn.focus();
        }
      });
      attachDrop.addEventListener("dragover", (e) => {
        e.preventDefault();
        attachDrop.classList.add("dragover");
      });
      attachDrop.addEventListener("dragleave", () => {
        attachDrop.classList.remove("dragover");
      });
      attachDrop.addEventListener("drop", (e) => {
        e.preventDefault();
        attachDrop.classList.remove("dragover");
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
          const dt = new DataTransfer();
          dt.items.add(files[0]);
          attachFileInput.files = dt.files;
          attachFileInput.dispatchEvent(new Event("change"));
        }
      });
      
      attachPath.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && attachPath.value.trim()) {
          e.preventDefault();
          addAttachPath(question.id, attachPath.value.trim(), attachBtn);
          attachPath.value = "";
        }
        if (e.key === "Tab") {
          e.preventDefault();
          if (e.shiftKey) {
            attachDrop.focus();
          } else {
            attachBtn.click();
            attachBtn.focus();
          }
        }
        if (e.key === "Escape") {
          attachBtn.click();
          attachBtn.focus();
        }
        if (e.key === "ArrowRight" && attachPath.selectionStart === attachPath.value.length) {
          e.preventDefault();
          e.stopPropagation();
          nextQuestion();
        }
        if (e.key === "ArrowLeft" && attachPath.selectionStart === 0) {
          e.preventDefault();
          e.stopPropagation();
          prevQuestion();
        }
      });
      
      attachInline.appendChild(attachFileInput);
      attachInline.appendChild(attachDrop);
      attachInline.appendChild(attachPath);
      attachInline.appendChild(attachItems);
      
      attachHint.appendChild(attachBtn);
      card.appendChild(attachHint);
      card.appendChild(attachInline);
    }

    const error = document.createElement("div");
    error.className = "field-error";
    error.dataset.errorFor = question.id;
    error.setAttribute("aria-live", "polite");
    card.appendChild(error);

    return card;
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => resolve(img);
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Failed to load image"));
      };
      img.src = url;
    });
  }

  async function validateImage(file) {
    if (!ALLOWED_TYPES.includes(file.type)) {
      return { valid: false, error: "Invalid file type. Use PNG, JPG, GIF, or WebP." };
    }
    if (file.size > MAX_SIZE) {
      return { valid: false, error: "Image exceeds 5MB limit." };
    }

    const img = await loadImage(file);
    if (img.src) URL.revokeObjectURL(img.src);
    if (img.width > MAX_DIMENSION || img.height > MAX_DIMENSION) {
      return { valid: false, error: `Image exceeds ${MAX_DIMENSION}x${MAX_DIMENSION} limit.` };
    }
    return { valid: true };
  }

  function updateImagePreview(id) {
    renderSelectedItems(id);
  }

  function clearImage(id) {
    const input = document.querySelector(
      `input[type="file"][data-question-id="${escapeSelector(id)}"]`
    );
    if (input) input.value = "";
    imageState.delete(id);

    renderSelectedItems(id);
    setFieldError(id, "");
    debounceSave();
  }

  function updateAttachBtn(questionId, btn) {
    const hasFile = attachState.has(questionId);
    const paths = attachPathState.get(questionId) || [];
    if (hasFile || paths.length > 0) {
      btn.classList.add("has-attachment");
    } else {
      btn.classList.remove("has-attachment");
    }
  }

  function renderAttachItems(questionId, btn) {
    const container = document.querySelector(`[data-attach-items-for="${escapeSelector(questionId)}"]`);
    if (!container) return;
    container.innerHTML = "";
    
    const entry = attachState.get(questionId);
    if (entry) {
      const item = document.createElement("div");
      item.className = "selected-item selected-image";
      
      const img = document.createElement("img");
      const url = URL.createObjectURL(entry.file);
      img.src = url;
      img.onload = () => URL.revokeObjectURL(url);
      
      const name = document.createElement("span");
      name.className = "selected-item-name";
      name.textContent = entry.file.name;
      
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "selected-item-remove";
      removeBtn.textContent = "x";
      removeBtn.addEventListener("click", () => {
        attachState.delete(questionId);
        renderAttachItems(questionId, btn);
        updateAttachBtn(questionId, btn);
        debounceSave();
      });
      
      item.appendChild(img);
      item.appendChild(name);
      item.appendChild(removeBtn);
      container.appendChild(item);
    }
    
    const paths = attachPathState.get(questionId) || [];
    paths.forEach((p) => {
      const item = document.createElement("div");
      item.className = "selected-item selected-path";
      
      const pathText = document.createElement("span");
      pathText.className = "selected-item-path";
      pathText.textContent = p;
      
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "selected-item-remove";
      removeBtn.textContent = "x";
      removeBtn.addEventListener("click", () => {
        const arr = attachPathState.get(questionId) || [];
        const idx = arr.indexOf(p);
        if (idx > -1) arr.splice(idx, 1);
        renderAttachItems(questionId, btn);
        updateAttachBtn(questionId, btn);
        debounceSave();
      });
      
      item.appendChild(pathText);
      item.appendChild(removeBtn);
      container.appendChild(item);
    });
    
    updateAttachBtn(questionId, btn);
  }

  async function handleAttachChange(questionId, input, btn) {
    const card = input.closest(".question-card");
    const errorEl = card?.querySelector(".field-error");
    
    const file = input.files && input.files[0];
    if (!file) {
      attachState.delete(questionId);
      renderAttachItems(questionId, btn);
      return;
    }

    try {
      const validation = await validateImage(file);
      if (!validation.valid) {
        if (errorEl) errorEl.textContent = validation.error;
        input.value = "";
        return;
      }
    } catch (err) {
      if (errorEl) errorEl.textContent = "Failed to validate image.";
      input.value = "";
      return;
    }

    if (errorEl) errorEl.textContent = "";
    attachState.set(questionId, { file });
    renderAttachItems(questionId, btn);
    debounceSave();
  }

  function addAttachPath(questionId, path, btn) {
    const paths = attachPathState.get(questionId) || [];
    if (!paths.includes(path)) {
      paths.push(path);
      attachPathState.set(questionId, paths);
      renderAttachItems(questionId, btn);
      debounceSave();
    }
  }

  function countImages(excludingId) {
    let count = 0;
    imageState.forEach((_value, key) => {
      if (key !== excludingId) count += 1;
    });
    return count;
  }

  async function handleImageChange(id, input) {
    clearGlobalError();
    setFieldError(id, "");

    const file = input.files && input.files[0];
    if (!file) {
      clearImage(id);
      return;
    }

    if (countImages(id) + 1 > MAX_IMAGES) {
      setFieldError(id, `Only ${MAX_IMAGES} images allowed.`);
      input.value = "";
      return;
    }

    try {
      const validation = await validateImage(file);
      if (!validation.valid) {
        setFieldError(id, validation.error);
        input.value = "";
        return;
      }
    } catch (err) {
      setFieldError(id, "Failed to validate image.");
      input.value = "";
      return;
    }

    imageState.set(id, { file });
    updateImagePreview(id);
    debounceSave();
  }

  function collectResponses() {
    const responses = [];

    questions.forEach((question) => {
      const resp = { id: question.id };
      
      if (question.type === "single") {
        const selected = formEl.querySelector(
          `input[name="${escapeSelector(question.id)}"]:checked`
        );
        resp.value = selected ? selected.value : "";
      }

      if (question.type === "multi") {
        const selected = Array.from(
          formEl.querySelectorAll(`input[name="${escapeSelector(question.id)}"]:checked`)
        ).map((input) => input.value);
        resp.value = selected;
      }

      if (question.type === "text") {
        const textarea = formEl.querySelector(
          `textarea[data-question-id="${escapeSelector(question.id)}"]`
        );
        resp.value = textarea ? textarea.value : "";
      }

      if (question.type === "image") {
        const paths = imagePathState.get(question.id) || [];
        resp.value = paths;
        resp.type = "paths";
      }
      
      if (question.type !== "image") {
        const attachPaths = attachPathState.get(question.id) || [];
        if (attachPaths.length > 0) {
          resp.attachments = attachPaths;
        }
      }

      responses.push(resp);
    });

    return responses;
  }

  function collectPersistedData() {
    const data = {};
    questions.forEach((question) => {
      if (question.type === "single") {
        const selected = formEl.querySelector(
          `input[name="${escapeSelector(question.id)}"]:checked`
        );
        data[question.id] = selected ? selected.value : "";
      }
      if (question.type === "multi") {
        const selected = Array.from(
          formEl.querySelectorAll(`input[name="${escapeSelector(question.id)}"]:checked`)
        ).map((input) => input.value);
        data[question.id] = selected;
      }
      if (question.type === "text") {
        const textarea = formEl.querySelector(
          `textarea[data-question-id="${escapeSelector(question.id)}"]`
        );
        data[question.id] = textarea ? textarea.value : "";
      }
    });
    return data;
  }

  function populateForm(saved) {
    if (!saved) return;
    questions.forEach((question) => {
      const value = saved[question.id];
      if (question.type === "single" && typeof value === "string") {
        const radios = formEl.querySelectorAll(
          `input[name="${escapeSelector(question.id)}"]`
        );
        radios.forEach((radio) => {
          radio.checked = false;
        });
        if (value !== "") {
          const input = formEl.querySelector(
            `input[name="${escapeSelector(question.id)}"][value="${escapeSelector(value)}"]`
          );
          if (input) input.checked = true;
        }
      }
      if (question.type === "multi" && Array.isArray(value)) {
        const checkboxes = formEl.querySelectorAll(
          `input[name="${escapeSelector(question.id)}"]`
        );
        checkboxes.forEach((checkbox) => {
          checkbox.checked = false;
        });
        value.forEach((val) => {
          const input = formEl.querySelector(
            `input[name="${escapeSelector(question.id)}"][value="${escapeSelector(val)}"]`
          );
          if (input) input.checked = true;
        });
      }
      if (question.type === "text" && typeof value === "string") {
        const textarea = formEl.querySelector(
          `textarea[data-question-id="${escapeSelector(question.id)}"]`
        );
        if (textarea) textarea.value = value;
      }
    });
  }

  function saveProgress() {
    if (!storageKey) return;
    const data = collectPersistedData();
    try {
      localStorage.setItem(storageKey, JSON.stringify(data));
    } catch (_err) {
      // ignore storage errors
    }
  }

  function loadProgress() {
    if (!storageKey) return;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        populateForm(JSON.parse(saved));
        questions.forEach((q) => {
          if (q.type === "multi") {
            updateDoneState(q.id);
          }
        });
      }
    } catch (_err) {
      // ignore storage errors
    }
  }

  function clearProgress() {
    if (!storageKey) return;
    try {
      localStorage.removeItem(storageKey);
    } catch (_err) {
      // ignore storage errors
    }
  }

  async function hashQuestions() {
    const json = JSON.stringify(questions);
    const encoder = new TextEncoder();
    const data = encoder.encode(json);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    return hashHex.slice(0, 8);
  }

  async function initStorage() {
    try {
      const hash = await hashQuestions();
      storageKey = `pi-interview-${hash}`;
      loadProgress();
    } catch (_err) {
      storageKey = null;
    }
  }

  function readFileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== "string") {
          reject(new Error("Failed to read file"));
          return;
        }
        const parts = reader.result.split(",");
        resolve(parts[1] || "");
      };
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });
  }

  async function buildPayload() {
    const responses = collectResponses();
    const images = [];

    for (const [id, entry] of imageState.entries()) {
      const file = entry.file;
      const data = await readFileBase64(file);
      images.push({
        id,
        filename: file.name,
        mimeType: file.type,
        data,
      });
    }
    
    for (const [id, entry] of attachState.entries()) {
      const file = entry.file;
      const data = await readFileBase64(file);
      images.push({
        id,
        filename: file.name,
        mimeType: file.type,
        data,
        isAttachment: true,
      });
    }

    return { responses, images };
  }

  async function submitForm(event) {
    event.preventDefault();
    clearGlobalError();
    clearFieldErrors();

    submitBtn.disabled = true;

    try {
      const payload = await buildPayload();
      const response = await fetch("/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: sessionToken, ...payload }),
      });

      const data = await response.json().catch(() => ({ ok: false, error: "Invalid server response" }));

      if (!response.ok || !data.ok) {
        if (data.field) {
          setFieldError(data.field, data.error || "Invalid input");
        } else {
          showGlobalError(data.error || "Submission failed.");
        }
        submitBtn.disabled = false;
        return;
      }

      clearProgress();
      successOverlay.classList.remove("hidden");
      setTimeout(() => {
        window.close();
      }, 800);
    } catch (err) {
      if (isNetworkError(err)) {
        showSessionExpired();
      } else {
        showGlobalError("Failed to submit responses.");
        submitBtn.disabled = false;
      }
    }
  }

  function init() {
    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    const modKey = document.querySelector(".mod-key");
    if (modKey) {
      modKey.textContent = isMac ? "⌘" : "Ctrl";
    }
    
    setText(titleEl, data.title || "Interview");
    setText(descriptionEl, data.description || "");

    questions.forEach((question, index) => {
      containerEl.appendChild(createQuestionCard(question, index));
    });

    initStorage();

    formEl.addEventListener("submit", submitForm);
    submitBtn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        focusQuestion(questionCards.length - 1, 'prev');
      }
    });
    
    closeTabBtn.addEventListener("click", () => {
      if (countdownInterval) clearInterval(countdownInterval);
      window.close();
    });

    stayBtn.addEventListener("click", () => {
      if (countdownInterval) clearInterval(countdownInterval);
      expiredOverlay.classList.remove("visible");
      expiredOverlay.classList.add("hidden");
      
      sessionExpired = false;
      submitBtn.disabled = false;
      
      if (timeout > 0) {
        startCountdownDisplay();
        expirationTimeout = setTimeout(() => {
          showSessionExpired();
        }, timeout * 1000);
      }
    });

    document.addEventListener("keydown", (e) => {
      if (expiredOverlay.classList.contains("visible")) {
        if (e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          if (document.activeElement === stayBtn) {
            closeTabBtn.focus();
          } else {
            stayBtn.focus();
          }
        }
      }
    }, true);

    if (timeout > 0) {
      startCountdownDisplay();
      expirationTimeout = setTimeout(() => {
        showSessionExpired();
      }, timeout * 1000);
      
      ["click", "keydown", "input", "change"].forEach(event => {
        formEl.addEventListener(event, refreshCountdown, { passive: true });
      });
      document.addEventListener("mousemove", refreshCountdown, { passive: true });
    }

    initQuestionNavigation();
  }

  init();
})();
