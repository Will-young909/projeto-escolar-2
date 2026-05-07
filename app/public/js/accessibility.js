// Accessibility Preferences Logic

document.addEventListener('DOMContentLoaded', () => {
    // --- Preferences & State ---
    const defaultPreferences = {
        fontSize: 1.0,
        letterSpacing: 0,
        lineHeight: 1.5,
        highContrast: false,
        grayscale: false,
        underlineLinks: false,
        readerFont: false,
        dyslexiaFont: false,
        reduceMotion: false,
        screenReaderFocus: false
    };

    let preferences = { ...defaultPreferences };

    // --- HTML Injection ---
    const accessibilityModalHTML = `
        <div id="accessibility-modal" class="a11y-modal">
            <div class="a11y-modal-content">
                <button id="a11y-close-modal" class="a11y-close-btn" aria-label="Fechar painel de acessibilidade">&times;</button>
                <h3 class="a11y-title">Preferências de Acessibilidade</h3>
                
                <div class="a11y-group">
                    <h4>Texto e Conteúdo</h4>
                    <div class="a11y-control-grid">
                        <button id="increase-font"><i class="fas fa-font"></i> Aumentar Fonte</button>
                        <button id="decrease-font"><i class="fas fa-font"></i> Diminuir Fonte</button>
                        <button id="increase-letter-spacing"><i class="fas fa-text-width"></i> Aumentar Espaçamento</button>
                        <button id="decrease-letter-spacing"><i class="fas fa-text-width"></i> Diminuir Espaçamento</button>
                        <button id="increase-line-height"><i class="fas fa-text-height"></i> Aumentar Linha</button>
                        <button id="decrease-line-height"><i class="fas fa-text-height"></i> Diminuir Linha</button>
                        <button id="underline-links"><i class="fas fa-underline"></i> Sublinhar Links</button>
                    </div>
                </div>

                <div class="a11y-group">
                    <h4>Leitura e Foco</h4>
                    <div class="a11y-control-grid tts-grid">
                        <p>Leitor de Tela</p>
                        <div id="tts-controls">
                            <button id="tts-play" aria-label="Play"><i class="fas fa-play"></i></button>
                            <button id="tts-pause" aria-label="Pause"><i class="fas fa-pause"></i></button>
                            <button id="tts-stop" aria-label="Stop"><i class="fas fa-stop"></i></button>
                        </div>
                    </div>
                </div>

                <div class="a11y-group">
                    <h4>Esquemas de Cores e Fontes</h4>
                    <div class="a11y-control-grid">
                        <button id="high-contrast"><i class="fas fa-adjust"></i> Alto Contraste</button>
                        <button id="grayscale"><i class="fas fa-palette"></i> Escala de Cinza</button>
                        <button id="reader-font"><i class="fas fa-book-reader"></i> Fonte Amigável</button>
                        <button id="dyslexia-font"><i class="fas fa-eye"></i> Fonte para Dislexia</button>
                    </div>
                </div>
                
                <div class="a11y-group">
                     <h4>Animações</h4>
                     <button id="reduce-motion"><i class="fas fa-wind"></i> Reduzir Animações</button>
                </div>

                <div class="a11y-footer">
                    <button id="reset-accessibility">Redefinir</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', accessibilityModalHTML);

    // --- Element Selectors ---
    const openModalButton = document.getElementById('a11y-open-modal');
    const closeModalButton = document.getElementById('a11y-close-modal');
    const accessibilityModal = document.getElementById('accessibility-modal');
    
    // Modal and Panel controls
    const ttsPlayButton = document.getElementById('tts-play');
    const ttsPauseButton = document.getElementById('tts-pause');
    const ttsStopButton = document.getElementById('tts-stop');
    const ttsControls = document.getElementById('tts-controls');
    const increaseFontButton = document.getElementById('increase-font');
    const decreaseFontButton = document.getElementById('decrease-font');
    const increaseLetterSpacingButton = document.getElementById('increase-letter-spacing');
    const decreaseLetterSpacingButton = document.getElementById('decrease-letter-spacing');
    const increaseLineHeightButton = document.getElementById('increase-line-height');
    const decreaseLineHeightButton = document.getElementById('decrease-line-height');
    const highContrastButton = document.getElementById('high-contrast');
    const grayscaleButton = document.getElementById('grayscale');
    const underlineLinksButton = document.getElementById('underline-links');
    const readerFontButton = document.getElementById('reader-font');
    const dyslexiaFontButton = document.getElementById('dyslexia-font');
    const reduceMotionButton = document.getElementById('reduce-motion');
    const resetButton = document.getElementById('reset-accessibility');

    // --- Modal Logic ---
    function openModal() {
        accessibilityModal.classList.add('a11y-modal--visible');
    }
    function closeModal() {
        accessibilityModal.classList.remove('a11y-modal--visible');
    }

    openModalButton.addEventListener('click', openModal);
    closeModalButton.addEventListener('click', (e) => {
        e.stopPropagation();
        closeModal();
    });
    accessibilityModal.addEventListener('click', (e) => { // Close on overlay click
        if (e.target === accessibilityModal) {
            closeModal();
        }
    });

    // --- Core Functions ---
    savePreferences = () => {
        localStorage.setItem('accessibilityPreferences', JSON.stringify(preferences));
    }

    applyPreferences = () => {
        const bodyStyle = document.body.style;
        const baseFontSize = 16;
        
        bodyStyle.fontSize = `${baseFontSize * preferences.fontSize}px`;
        bodyStyle.letterSpacing = `${preferences.letterSpacing}px`;
        bodyStyle.lineHeight = preferences.lineHeight;

        document.body.classList.toggle('high-contrast', preferences.highContrast);
        document.body.classList.toggle('grayscale', preferences.grayscale);
        document.body.classList.toggle('underline-links', preferences.underlineLinks);
        document.body.classList.toggle('reader-font', preferences.readerFont);
        document.body.classList.toggle('dyslexia-font', preferences.dyslexiaFont);
        document.body.classList.toggle('reduce-motion', preferences.reduceMotion);
    }

    loadPreferences = () => {
        const savedPreferences = localStorage.getItem('accessibilityPreferences');
        if (savedPreferences) {
            preferences = { ...defaultPreferences, ...JSON.parse(savedPreferences) };
        }
        applyPreferences();
    }

    resetPreferences = () => {
        speechSynthesis.cancel();
        localStorage.removeItem('accessibilityPreferences');
        window.location.reload();
    }

    // ==============================
    // 🔊 TEXT-TO-SPEECH AVANÇADO
    // ==============================

    let currentUtterance = null;
    let isReading = false;
    let currentIndex = 0;
    let elementsToRead = [];

    // 🔎 Extrai conteúdo de forma inteligente
    function getReadableElements() {
        const main = document.querySelector("main");
        if (!main) return [];

        return Array.from(
            main.querySelectorAll("h1, h2, h3, p, li, a, button")
        ).filter(el => {
            const isVisible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
            const hasText = el.innerText.trim().length > 0;
            return isVisible && hasText;
        });
    }

    // 🎨 Highlight visual
    function highlightElement(el) {
        removeHighlight();
        el.classList.add("a11y-reading");
    }

    function removeHighlight() {
        document.querySelectorAll(".a11y-reading").forEach(el => {
            el.classList.remove("a11y-reading");
        });
    }

    // 🧠 Cria fala com configuração ideal
    function createUtterance(text) {
        const utterance = new SpeechSynthesisUtterance(text);

        utterance.lang = "pt-BR";
        utterance.rate = 0.9;
        utterance.pitch = 1;
        utterance.volume = 1;

        const voices = speechSynthesis.getVoices();
        const ptVoice = voices.find(v => v.lang.includes("pt"));
        if (ptVoice) utterance.voice = ptVoice;

        return utterance;
    }

    // ▶️ Leitura por blocos
    function speakNext() {
        if (currentIndex >= elementsToRead.length || !isReading) {
            stopSpeech();
            return;
        }

        const el = elementsToRead[currentIndex];
        highlightElement(el);

        const text = el.innerText;
        currentUtterance = createUtterance(text);

        currentUtterance.onend = () => {
            currentIndex++;
            speakNext();
        };
        
        currentUtterance.onerror = (event) => {
            console.error("Erro no speech synthesis:", event.error);
            currentIndex++;
            speakNext(); // Tenta continuar com o próximo
        };

        speechSynthesis.speak(currentUtterance);
    }

    // ▶️ PLAY
    function playSpeech() {
        if (speechSynthesis.paused && isReading) {
            speechSynthesis.resume();
            return;
        }

        if (isReading) return;

        elementsToRead = getReadableElements();
        currentIndex = 0;
        isReading = true;
        
        // Garante que a síntese de voz está pronta
        if (speechSynthesis.getVoices().length === 0) {
            speechSynthesis.onvoiceschanged = () => {
                speakNext();
            };
        } else {
            speakNext();
        }
    }

    // ⏸️ PAUSE
    function pauseSpeech() {
        if (speechSynthesis.speaking) {
            speechSynthesis.pause();
        }
    }

    // ⏹️ STOP
    function stopSpeech() {
        speechSynthesis.cancel();
        isReading = false;
        currentIndex = 0;
        removeHighlight();
    }
    
    // ==============================
    // 🖱️ LEITURA POR SELEÇÃO
    // ==============================
    document.addEventListener("mouseup", () => {
        const selected = window.getSelection().toString().trim();

        if (selected.length > 5) { // Evita leituras acidentais
            stopSpeech();
            const utterance = createUtterance(selected);
            speechSynthesis.speak(utterance);
        }
    });

    // ==============================
    // 🎯 LEITURA POR FOCO (OPCIONAL)
    // ==============================
    document.addEventListener("focusin", (e) => {
        if (!preferences.screenReaderFocus) return;

        const el = e.target;
        // Evita ler o body/html e elementos sem texto ou placeholders
        if (el === document.body || el === document.documentElement) return;

        const text = el.innerText || el.getAttribute('aria-label') || el.title || el.placeholder;
        if (!text || text.trim().length === 0) return;
        
        stopSpeech(); // Para a leitura anterior para focar na nova
        const utterance = createUtterance(text);
        speechSynthesis.speak(utterance);
    });
    
    // ==============================
    // ⌨️ ATALHO DE TECLADO
    // ALT + R = LER/PARAR
    // ==============================
    document.addEventListener("keydown", (e) => {
        if (e.altKey && e.key.toLowerCase() === "r") {
            e.preventDefault(); // Previne qualquer comportamento padrão do navegador
            if (isReading) {
                stopSpeech();
            } else {
                playSpeech();
            }
        }
    });

    // ==============================
    // 🔘 CONECTAR COM BOTÕES
    // ==============================
    if(ttsPlayButton) ttsPlayButton.addEventListener('click', playSpeech);
    if(ttsPauseButton) ttsPauseButton.addEventListener('click', pauseSpeech);
    if(ttsStopButton) ttsStopButton.addEventListener('click', stopSpeech);

    // --- Event Handlers ---
    increaseFontButton.addEventListener('click', () => {
        preferences.fontSize = Math.min(preferences.fontSize * 1.1, 2.5);
        savePreferences();
        applyPreferences();
    });

    decreaseFontButton.addEventListener('click', () => {
        preferences.fontSize = Math.max(preferences.fontSize * 0.9, 0.8);
        savePreferences();
        applyPreferences();
    });

    increaseLetterSpacingButton.addEventListener('click', () => {
        preferences.letterSpacing = Math.min(preferences.letterSpacing + 0.1, 7);
        savePreferences();
        applyPreferences();
    });

    decreaseLetterSpacingButton.addEventListener('click', () => {
        preferences.letterSpacing = Math.max(preferences.letterSpacing - 0.1, 0);
        savePreferences();
        applyPreferences();
    });

    increaseLineHeightButton.addEventListener('click', () => {
        preferences.lineHeight = Math.min(preferences.lineHeight + 0.1, 3.5);
        savePreferences();
        applyPreferences();
    });

    decreaseLineHeightButton.addEventListener('click', () => {
        preferences.lineHeight = Math.max(preferences.lineHeight - 0.1, 1.2);
        savePreferences();
        applyPreferences();
    });

    function createToggleHandler(preferenceKey) {
        return () => {
            preferences[preferenceKey] = !preferences[preferenceKey];
            savePreferences();
            applyPreferences();
            
            // Ativa/desativa o leitor de foco
            if (preferenceKey === 'screenReaderFocus') {
                if (!preferences.screenReaderFocus) {
                    stopSpeech(); // Para de ler ao desativar
                }
            }
        };
    }

    highContrastButton.addEventListener('click', createToggleHandler('highContrast'));
    grayscaleButton.addEventListener('click', createToggleHandler('grayscale'));
    underlineLinksButton.addEventListener('click', createToggleHandler('underlineLinks'));
    readerFontButton.addEventListener('click', createToggleHandler('readerFont'));
    dyslexiaFontButton.addEventListener('click', createToggleHandler('dyslexiaFont'));
    reduceMotionButton.addEventListener('click', createToggleHandler('reduceMotion'));
    
    // Botão para leitor de foco (se existir um botão específico para ele)
    const screenReaderFocusButton = document.getElementById('screen-reader-focus'); // Supondo que haja um botão com este ID
    if (screenReaderFocusButton) {
        screenReaderFocusButton.addEventListener('click', createToggleHandler('screenReaderFocus'));
    }


    resetButton.addEventListener('click', resetPreferences);

    window.addEventListener('beforeunload', () => {
        // Limpa a fila de fala para evitar problemas ao recarregar
        speechSynthesis.cancel();
    });

    // --- Initial Load ---
    loadPreferences();
});
