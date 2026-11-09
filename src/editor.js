/*
 * LaTeX editing aids for a plain <textarea>: syntax colouring and
 * autocompletion with snippets.
 *
 * Colouring works by drawing highlighted text in a layer exactly behind the
 * textarea, whose own text is made transparent (the caret and selection stay
 * visible). Completion pops up while typing a command after "\", an
 * environment name after "\begin{", or a label after "\ref{"/"\eqref{"/….
 *
 *   TeXdownEditor.attach(textarea, { labels: () => ({key: {num, kindName}}),
 *                                    source: () => fullDocumentText })
 *
 * Works in the browser only (window.TeXdownEditor).
 */
(function (root) {
  'use strict';

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ---------------------------------------------------------------------------
  // Syntax colouring
  // ---------------------------------------------------------------------------

  const MATH_ENVS = /^(equation|align|gather|multline|flalign|alignat|eqnarray|displaymath|math)\*?$/;
  const LABEL_CMDS = /^(label|ref|eqref|cref|Cref|autoref|pageref|nameref|cite|citep|citet|bibitem)$/;

  function findClose(src, token, from) {
    for (let i = from; i < src.length; i++) {
      if (src.startsWith(token, i)) return i;
      if (src[i] === '\\') i++;
    }
    return -1;
  }

  /** Turn LaTeX source into HTML with <span class="tok-…"> around tokens. */
  function highlight(src, inMath) {
    let out = '';
    let i = 0;
    let plain = '';
    const flush = () => { if (plain) { out += esc(plain); plain = ''; } };
    const tok = (cls, text) => { flush(); out += `<span class="tok-${cls}">${esc(text)}</span>`; };
    const math = (open, inner, close) => {
      flush();
      out += `<span class="tok-math"><span class="tok-delim">${esc(open)}</span>${highlight(inner, true)}<span class="tok-delim">${esc(close)}</span></span>`;
    };
    while (i < src.length) {
      const c = src[i];
      if (c === '%') {
        let j = src.indexOf('\n', i);
        if (j < 0) j = src.length;
        tok('comment', src.slice(i, j));
        i = j;
      } else if (c === '$' && !inMath) {
        const dbl = src[i + 1] === '$';
        const open = dbl ? '$$' : '$';
        const j = findClose(src, open, i + open.length);
        if (j < 0) { tok('math', src.slice(i)); i = src.length; continue; }
        math(open, src.slice(i + open.length, j), open);
        i = j + open.length;
      } else if (c === '\\') {
        const d = src[i + 1];
        if (!inMath && (d === '(' || d === '[')) {
          const close = d === '(' ? '\\)' : '\\]';
          const j = findClose(src, close, i + 2);
          if (j < 0) { tok('math', src.slice(i)); i = src.length; continue; }
          math('\\' + d, src.slice(i + 2, j), close);
          i = j + 2;
          continue;
        }
        if (d && /[A-Za-z@]/.test(d)) {
          let j = i + 1;
          while (j < src.length && /[A-Za-z@]/.test(src[j])) j++;
          const name = src.slice(i + 1, j);
          const arg = /^(\*?)\{([^{}\n]*)\}/.exec(src.slice(j));
          if ((name === 'begin' || name === 'end') && arg) {
            tok('kw', '\\' + name + arg[1] + '{');
            tok('env', arg[2]);
            tok('kw', '}');
            i = j + arg[0].length;
            // Colour the body of a math environment as math.
            if (name === 'begin' && MATH_ENVS.test(arg[2]) && !inMath) {
              const endTok = `\\end{${arg[2]}}`;
              const k = src.indexOf(endTok, i);
              if (k >= 0) {
                flush();
                out += `<span class="tok-math">${highlight(src.slice(i, k), true)}</span>`;
                i = k;
              }
            }
            continue;
          }
          if (LABEL_CMDS.test(name) && arg) {
            tok('cmd', '\\' + name + arg[1]);
            tok('brace', '{');
            tok('label', arg[2]);
            tok('brace', '}');
            i = j + arg[0].length;
            continue;
          }
          tok(/^(section|subsection|subsubsection|chapter|part|paragraph)$/.test(name) ? 'section' : 'cmd', src.slice(i, j));
          i = j;
        } else {
          tok(d === '\\' ? 'align' : 'cmd', src.slice(i, i + 2));
          i += 2;
        }
      } else if (c === '{' || c === '}' || c === '[' || c === ']') {
        tok('brace', c);
        i++;
      } else if (c === '&') {
        tok('align', c);
        i++;
      } else {
        plain += c;
        i++;
      }
    }
    flush();
    return out;
  }

  // ---------------------------------------------------------------------------
  // Snippets
  // ---------------------------------------------------------------------------

  // ${n:default} and $n are tab stops (in order 1, 2, …, then 0); \t indents.
  const env = (name, extra) => ({
    name, label: `\\begin{${name}}`, detail: 'environment',
    body: `\\begin{${name}}${extra || ''}\n\t$0\n\\end{${name}}`,
  });
  const SNIPPETS = [
    { name: 'section', body: '\\section{${1:Title}}\\label{sec:${2:key}}$0', detail: 'section' },
    { name: 'subsection', body: '\\subsection{${1:Title}}$0', detail: 'subsection' },
    { name: 'subsubsection', body: '\\subsubsection{${1:Title}}$0', detail: 'subsubsection' },
    { name: 'begin', body: '\\begin{$1', detail: 'start an environment' },
    { name: 'frac', body: '\\frac{${1:a}}{${2:b}}$0', detail: 'fraction' },
    { name: 'dfrac', body: '\\dfrac{${1:a}}{${2:b}}$0' },
    { name: 'sqrt', body: '\\sqrt{${1:x}}$0' },
    { name: 'sum', body: '\\sum_{${1:i=1}}^{${2:n}} $0', detail: 'sum with limits' },
    { name: 'prod', body: '\\prod_{${1:i=1}}^{${2:n}} $0' },
    { name: 'int', body: '\\int_{${1:a}}^{${2:b}} ${3:f(x)}\\,d${4:x}$0', detail: 'integral' },
    { name: 'lim', body: '\\lim_{${1:n \\to \\infty}} $0' },
    { name: 'left(', label: '\\left( … \\right)', body: '\\left( $1 \\right)$0' },
    { name: 'left[', label: '\\left[ … \\right]', body: '\\left[ $1 \\right]$0' },
    { name: 'left\\{', label: '\\left\\{ … \\right\\}', body: '\\left\\{ $1 \\right\\}$0' },
    { name: 'norm', label: '\\lVert … \\rVert', body: '\\lVert $1 \\rVert$0', detail: 'norm' },
    { name: 'abs', label: '\\lvert … \\rvert', body: '\\lvert $1 \\rvert$0', detail: 'absolute value' },
    { name: 'mathbb', body: '\\mathbb{${1:R}}$0' },
    { name: 'mathcal', body: '\\mathcal{${1:A}}$0' },
    { name: 'mathfrak', body: '\\mathfrak{${1:g}}$0' },
    { name: 'mathrm', body: '\\mathrm{$1}$0' },
    { name: 'operatorname', body: '\\operatorname{$1}$0' },
    { name: 'text', body: '\\text{$1}$0' },
    { name: 'textbf', body: '\\textbf{$1}$0', detail: 'bold' },
    { name: 'textit', body: '\\textit{$1}$0', detail: 'italic' },
    { name: 'emph', body: '\\emph{$1}$0', detail: 'emphasis' },
    { name: 'texttt', body: '\\texttt{$1}$0' },
    { name: 'label', body: '\\label{${1:key}}$0' },
    { name: 'ref', body: '\\ref{$1}$0', detail: 'reference' },
    { name: 'eqref', body: '\\eqref{$1}$0', detail: 'equation reference' },
    { name: 'cref', body: '\\cref{$1}$0', detail: 'reference with name' },
    { name: 'Cref', body: '\\Cref{$1}$0' },
    { name: 'cite', body: '\\cite{$1}$0' },
    { name: 'footnote', body: '\\footnote{$1}$0' },
    { name: 'item', body: '\\item $0' },
    { name: 'url', body: '\\url{$1}$0' },
    { name: 'href', body: '\\href{${1:https://}}{${2:text}}$0' },
    { name: 'includegraphics', body: '\\includegraphics[width=${1:0.8\\linewidth}]{${2:file}}$0' },
    { name: 'newcommand', body: '\\newcommand{\\${1:name}}{${2:body}}$0' },
    { name: 'newtheorem', body: '\\newtheorem{${1:lemma}}[${2:theorem}]{${3:Lemma}}$0' },
    { name: 'DeclareMathOperator', body: '\\DeclareMathOperator{\\${1:name}}{${2:name}}$0' },
    { name: 'overline', body: '\\overline{$1}$0' },
    { name: 'widehat', body: '\\widehat{$1}$0' },
    { name: 'widetilde', body: '\\widetilde{$1}$0' },
    { name: 'underbrace', body: '\\underbrace{$1}_{$2}$0' },
    { name: 'binom', body: '\\binom{${1:n}}{${2:k}}$0' },
    { name: 'xrightarrow', body: '\\xrightarrow{$1}$0' },
    { name: 'eqn', label: 'equation with label', detail: 'snippet', body: '\\begin{equation}\\label{eq:${1:key}}\n\t$0\n\\end{equation}' },
    { name: 'thm', label: 'theorem with label', detail: 'snippet', body: '\\begin{theorem}\\label{thm:${1:key}}\n\t$2\n\\end{theorem}\n\\begin{proof}\n\t$0\n\\end{proof}' },
    { name: 'lem', label: 'lemma with proof', detail: 'snippet', body: '\\begin{lemma}\\label{lem:${1:key}}\n\t$2\n\\end{lemma}\n\\begin{proof}\n\t$0\n\\end{proof}' },
    { name: 'defn', label: 'definition with label', detail: 'snippet', body: '\\begin{definition}\\label{def:${1:key}}\n\t$0\n\\end{definition}' },
    { name: 'cases', label: '\\begin{cases}', detail: 'piecewise', body: '\\begin{cases}\n\t${1:a} & \\text{if } ${2:x > 0}, \\\\\n\t${3:b} & \\text{otherwise}.\n\\end{cases}$0' },
    { name: 'pmatrix', label: '\\begin{pmatrix}', detail: 'matrix', body: '\\begin{pmatrix}\n\t${1:a} & ${2:b} \\\\\n\t${3:c} & ${4:d}\n\\end{pmatrix}$0' },
    { name: 'bmatrix', label: '\\begin{bmatrix}', detail: 'matrix', body: '\\begin{bmatrix}\n\t${1:a} & ${2:b} \\\\\n\t${3:c} & ${4:d}\n\\end{bmatrix}$0' },
    { name: 'align', label: '\\begin{align}', detail: 'environment', body: '\\begin{align}\n\t${1:a} &= ${2:b} \\\\\n\t&= ${3:c}\n\\end{align}$0' },
    { name: 'itemize', label: '\\begin{itemize}', detail: 'environment', body: '\\begin{itemize}\n\t\\item $0\n\\end{itemize}' },
    { name: 'enumerate', label: '\\begin{enumerate}', detail: 'environment', body: '\\begin{enumerate}\n\t\\item $0\n\\end{enumerate}' },
    { name: 'figure', label: '\\begin{figure}', detail: 'environment', body: '\\begin{figure}[h]\n\t\\centering\n\t\\includegraphics[width=${1:0.8\\linewidth}]{${2:file}}\n\t\\caption{${3:Caption}}\\label{fig:${4:key}}\n\\end{figure}$0' },
    { name: 'table', label: '\\begin{table}', detail: 'environment', body: '\\begin{table}[h]\n\t\\centering\n\t\\begin{tabular}{${1:lc}}\n\t\t${2:a} & ${3:b} \\\\\n\t\\end{tabular}\n\t\\caption{${4:Caption}}\\label{tab:${5:key}}\n\\end{table}$0' },
    env('equation'), env('equation*'), env('align*'), env('gather'), env('proof'), env('theorem'), env('lemma'),
    env('proposition'), env('corollary'), env('definition'), env('remark'), env('example'), env('abstract'),
    env('center'), env('quote'), env('description'),
  ];

  const SYMBOLS = (
    'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma tau ' +
    'upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega infty partial nabla ' +
    'cdot cdots ldots dots vdots ddots times div pm mp circ bullet leq le geq ge neq ne approx equiv sim simeq cong ' +
    'propto subset subseteq supset supseteq in notin ni cup cap bigcup bigcap setminus emptyset varnothing ' +
    'to mapsto rightarrow leftarrow Rightarrow Leftarrow Leftrightarrow implies iff hookrightarrow ' +
    'forall exists nexists neg land lor wedge vee oplus otimes langle rangle lfloor rfloor lceil rceil ' +
    'quad qquad hat bar tilde vec dot ddot mid parallel perp prime ell hbar Re Im aleph ' +
    'sin cos tan log ln exp det dim ker max min sup inf deg gcd limsup liminf ' +
    'noindent medskip bigskip newline maketitle tableofcontents appendix qed today'
  ).split(' ').map((name) => ({ name, body: '\\' + name + '$0' }));

  // ---------------------------------------------------------------------------
  // Attaching to a textarea
  // ---------------------------------------------------------------------------

  let popup = null;

  function attach(textarea, opts) {
    opts = opts || {};
    // Wrap the textarea with the highlight layer behind it.
    const wrap = document.createElement('div');
    wrap.className = 'hl-wrap';
    textarea.parentNode.insertBefore(wrap, textarea);
    const layer = document.createElement('pre');
    layer.className = 'hl-layer';
    layer.setAttribute('aria-hidden', 'true');
    wrap.append(layer, textarea);
    textarea.classList.add('hl-input');

    let frame = 0;
    const copyStyles = () => {
      const cs = getComputedStyle(textarea);
      for (const p of ['font', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'wordBreak', 'overflowWrap', 'textIndent']) {
        layer.style[p] = cs[p];
      }
      layer.style.width = textarea.offsetWidth + 'px';
      layer.style.height = textarea.offsetHeight + 'px';
      // Leave room for the textarea's scrollbar so lines wrap at the same place.
      const scrollbar = textarea.offsetWidth - textarea.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
      layer.style.paddingRight = parseFloat(cs.paddingRight) + Math.max(0, scrollbar) + 'px';
    };
    const paint = () => {
      frame = 0;
      copyStyles();
      layer.innerHTML = highlight(textarea.value) + '\n';
      layer.scrollTop = textarea.scrollTop;
    };
    const refresh = () => { if (!frame) frame = requestAnimationFrame(paint); };
    textarea.addEventListener('input', refresh);
    textarea.addEventListener('scroll', () => { layer.scrollTop = textarea.scrollTop; layer.scrollLeft = textarea.scrollLeft; }, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(refresh).observe(textarea);
    paint();

    // --- completion ---------------------------------------------------------

    let items = [];
    let active = 0;
    let replaceFrom = 0;
    let stops = null; // tab stops of the last inserted snippet

    const close = () => {
      items = [];
      if (popup && popup.owner === textarea) popup.hidden = true;
    };

    function candidates() {
      const pos = textarea.selectionStart;
      if (pos !== textarea.selectionEnd) return null;
      const before = textarea.value.slice(Math.max(0, pos - 80), pos);
      let m = /\\(?:ref|eqref|cref|Cref|autoref|Autoref|pageref|nameref|vref)\*?\{([^{}\s]*,)?([^{},\s]*)$/.exec(before);
      if (m) {
        // Labels come from the text itself (so they are offered even while the
        // document is half-typed), with numbers from the last render.
        const labels = opts.labels ? opts.labels() : {};
        const prefix = m[2];
        const text = opts.source ? opts.source() : textarea.value;
        const close = textarea.value[pos] === '}' || textarea.value[pos] === ',' ? '' : '}';
        const keys = new Set(Object.keys(labels));
        for (const t of text.matchAll(/\\label\{([^{}]+)\}/g)) keys.add(t[1].trim());
        const list = Array.from(keys).map((key) => {
          const info = labels[key] || {};
          const kind = info.kindName || (info.kind && info.kind !== 'none' ? info.kind : '');
          return { name: key, label: key, detail: (kind ? kind + ' ' : '') + (info.num || ''), body: key + close + '$0', kind: 'label' };
        });
        return { from: pos - prefix.length, list: rank(list, prefix) };
      }
      m = /\\(begin|end)\{([A-Za-z*]*)$/.exec(before);
      if (m) {
        const prefix = m[2];
        const names = new Set(SNIPPETS.filter((s) => s.detail === 'environment').map((s) => s.name));
        ['align', 'itemize', 'enumerate', 'figure', 'table', 'tabular', 'cases', 'pmatrix', 'bmatrix', 'multline', 'array', 'verbatim', 'thebibliography'].forEach((n) => names.add(n));
        const text = opts.source ? opts.source() : textarea.value;
        for (const t of text.matchAll(/\\newtheorem\*?\{([^}]+)\}/g)) names.add(t[1].trim());
        const list = Array.from(names).map((name) => ({
          name, label: name, detail: m[1] === 'begin' ? 'environment' : '',
          body: m[1] === 'begin' ? `${name}}\n\t$0\n\\end{${name}}` : `${name}}$0`,
          kind: 'env',
        }));
        // Close the brace only if it is not already there.
        const after = textarea.value[pos];
        if (after === '}') list.forEach((it) => { it.body = it.name + '$0'; });
        return { from: pos - prefix.length, list: rank(list, prefix) };
      }
      m = /\\([A-Za-z]+)$/.exec(before);
      if (m) {
        const text = opts.source ? opts.source() : textarea.value;
        const own = [];
        for (const t of text.matchAll(/\\(?:newcommand|renewcommand|DeclareMathOperator)\*?\{?\\([A-Za-z]+)\}?/g)) {
          own.push({ name: t[1], body: '\\' + t[1] + '$0', detail: 'your macro' });
        }
        const list = rank(SNIPPETS.concat(own, SYMBOLS), m[1]);
        return { from: pos - m[1].length - 1, list };
      }
      return null;
    }

    function rank(list, prefix) {
      const p = prefix.toLowerCase();
      const seen = new Set();
      const starts = [];
      const contains = [];
      for (const it of list) {
        const key = it.name + '|' + it.body;
        if (seen.has(key)) continue;
        seen.add(key);
        const n = it.name.toLowerCase();
        if (n.startsWith(p)) starts.push(it);
        else if (p.length >= 2 && n.includes(p)) contains.push(it);
      }
      // Exact matches first, then case-matching prefixes, then shorter names.
      const score = (it) => (it.name === prefix ? 0 : it.name.startsWith(prefix) ? 1 : 2);
      starts.sort((a, b) => score(a) - score(b) || a.name.length - b.name.length);
      return starts.concat(contains).slice(0, 10);
    }

    function show() {
      const c = candidates();
      if (!c || !c.list.length) return close();
      items = c.list;
      active = 0;
      replaceFrom = c.from;
      if (!popup) {
        popup = document.createElement('ul');
        popup.className = 'completion';
        popup.setAttribute('role', 'listbox');
        document.body.appendChild(popup);
        popup.addEventListener('mousedown', (e) => {
          e.preventDefault(); // keep focus in the textarea
          const li = e.target.closest('li');
          if (li && popup.accept) popup.accept(Number(li.dataset.i));
        });
      }
      popup.owner = textarea;
      popup.accept = accept;
      drawPopup();
      const xy = caretXY(textarea, replaceFrom);
      popup.hidden = false;
      const w = popup.offsetWidth;
      const h = popup.offsetHeight;
      let left = Math.min(xy.x, window.innerWidth - w - 8);
      let top = xy.y + xy.h + 4;
      if (top + h > window.innerHeight - 8) top = xy.y - h - 4;
      popup.style.left = Math.max(8, left) + 'px';
      popup.style.top = Math.max(8, top) + 'px';
    }

    function drawPopup() {
      popup.innerHTML = items.map((it, k) =>
        `<li data-i="${k}" role="option" class="${k === active ? 'active' : ''}"${k === active ? ' aria-selected="true"' : ''}>` +
        `<span class="c-label">${esc(it.label || (it.kind ? it.name : '\\' + it.name))}</span>` +
        (it.detail ? `<span class="c-detail">${esc(it.detail)}</span>` : '') + '</li>'
      ).join('');
      const el = popup.children[active];
      if (el) el.scrollIntoView({ block: 'nearest' });
    }

    function accept(k) {
      const it = items[k];
      if (!it) return;
      close();
      insertSnippet(it.body, replaceFrom, textarea.selectionStart);
    }

    function insertSnippet(body, from, to) {
      const value = textarea.value;
      const lineStart = value.lastIndexOf('\n', from - 1) + 1;
      const indent = /^[ \t]*/.exec(value.slice(lineStart))[0];
      body = body.replace(/\t/g, '  ').replace(/\n/g, '\n' + indent);
      // Pull out the tab stops.
      let text = '';
      const found = {};
      const re = /\$\{(\d+):([^}]*)\}|\$(\d+)/g;
      let last = 0;
      let m;
      while ((m = re.exec(body))) {
        text += body.slice(last, m.index);
        const n = Number(m[1] || m[3]);
        const def = m[2] || '';
        found[n] = found[n] || [from + text.length, from + text.length + def.length];
        text += def;
        last = m.index + m[0].length;
      }
      text += body.slice(last);
      textarea.focus();
      textarea.setRangeText(text, from, to, 'end');
      const order = Object.keys(found).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
      if (found[0]) order.push(0);
      const list = order.map((n) => found[n]);
      if (list.length) {
        textarea.setSelectionRange(list[0][0], list[0][1]);
        stops = list.length > 1 ? { list, idx: 0, len: textarea.value.length } : null;
      } else stops = null;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function nextStop() {
      if (!stops) return false;
      const delta = textarea.value.length - stops.len;
      const cur = stops.list[stops.idx];
      const pos = textarea.selectionStart;
      // Give up if the cursor has wandered away from the current stop.
      if (pos < cur[0] || pos > cur[1] + delta) { stops = null; return false; }
      for (let k = stops.idx + 1; k < stops.list.length; k++) {
        stops.list[k] = [stops.list[k][0] + delta, stops.list[k][1] + delta];
      }
      stops.idx++;
      stops.len = textarea.value.length;
      const next = stops.list[stops.idx];
      textarea.setSelectionRange(next[0], next[1]);
      if (stops.idx >= stops.list.length - 1) stops = null;
      return true;
    }

    textarea.addEventListener('input', () => {
      if (document.activeElement === textarea) show();
    });
    textarea.addEventListener('keydown', (e) => {
      const open = items.length && popup && !popup.hidden && popup.owner === textarea;
      if (open) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
          drawPopup();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
          accept(active);
        } else if (e.key === 'Escape') {
          close();
        } else return;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (e.key === 'Tab' && !e.shiftKey && nextStop()) {
        e.preventDefault();
        e.stopImmediatePropagation();
      } else if (e.key === ' ' && e.ctrlKey) {
        e.preventDefault();
        show();
      }
    }, true);
    textarea.addEventListener('blur', close);
    textarea.addEventListener('click', () => { close(); stops = null; });

    return { refresh, close };
  }

  /** Viewport coordinates of character `pos` in a textarea. */
  function caretXY(textarea, pos) {
    const m = document.createElement('div');
    const cs = getComputedStyle(textarea);
    for (const p of ['font', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing', 'wordBreak', 'overflowWrap']) {
      m.style[p] = cs[p];
    }
    Object.assign(m.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', top: '0', left: '-10000px', width: textarea.clientWidth + 'px', borderStyle: 'solid' });
    m.textContent = textarea.value.slice(0, pos);
    const mark = document.createElement('span');
    mark.textContent = '\u200b';
    m.appendChild(mark);
    document.body.appendChild(m);
    const r = textarea.getBoundingClientRect();
    const x = r.left + mark.offsetLeft - textarea.scrollLeft;
    const y = r.top + mark.offsetTop - textarea.scrollTop;
    const h = mark.offsetHeight;
    m.remove();
    return { x, y, h };
  }

  root.TeXdownEditor = { attach, highlight };
})(typeof self !== 'undefined' ? self : this);
