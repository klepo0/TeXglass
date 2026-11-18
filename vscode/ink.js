// The SVG filters that give the handwritten notes look real ink (see the ink
// section of media/notes.css): ragged edges, ink that pools and thins along a
// stroke, and a little bleed into the paper. Inlined into the preview page;
// the web viewer loads this file too (window.TeXglassInk).
(function (root, svg) {
  if (typeof module === 'object' && module.exports) module.exports = svg;
  else root.TeXglassInk = svg;
})(typeof self !== 'undefined' ? self : this, "<svg class=\"tg-ink-filters\" width=\"0\" height=\"0\" aria-hidden=\"true\" focusable=\"false\" style=\"position:absolute;width:0;height:0;overflow:hidden\">\n" +
  "<defs>\n" +
  "<!-- Ballpoint: fine grain at the edges, ink thinning along the stroke, a hair of bleed. -->\n" +
  "<filter id=\"tg-ink-ballpoint\" x=\"-1%\" y=\"-5%\" width=\"102%\" height=\"110%\" color-interpolation-filters=\"sRGB\">\n" +
  "<feTurbulence type=\"fractalNoise\" baseFrequency=\"0.9\" numOctaves=\"2\" seed=\"3\" result=\"grain\"/>\n" +
  "<feDisplacementMap in=\"SourceGraphic\" in2=\"grain\" scale=\"1.3\" xChannelSelector=\"R\" yChannelSelector=\"G\" result=\"rough\"/>\n" +
  "<feTurbulence type=\"fractalNoise\" baseFrequency=\"0.045 0.09\" numOctaves=\"2\" seed=\"11\" result=\"flow\"/>\n" +
  "<feTurbulence type=\"fractalNoise\" baseFrequency=\"1.6\" numOctaves=\"1\" seed=\"5\" result=\"skip\"/>\n" +
  "<feComposite in=\"flow\" in2=\"skip\" operator=\"arithmetic\" k1=\"0\" k2=\"0.7\" k3=\"0.3\" k4=\"0\" result=\"mix\"/>\n" +
  "<feColorMatrix in=\"mix\" type=\"matrix\" values=\"0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -1.1 0 0 0 1.5\" result=\"density\"/>\n" +
  "<feComposite in=\"rough\" in2=\"density\" operator=\"in\" result=\"inked\"/>\n" +
  "<feGaussianBlur in=\"inked\" stdDeviation=\"0.3\" result=\"bleed\"/>\n" +
  "<feComponentTransfer in=\"bleed\" result=\"halo\"><feFuncA type=\"linear\" slope=\"0.55\"/></feComponentTransfer>\n" +
  "<feMerge><feMergeNode in=\"halo\"/><feMergeNode in=\"inked\"/></feMerge>\n" +
  "</filter>\n" +
  "<!-- Fountain pen: wetter, so ink pools and fades more and soaks a little further into the paper. -->\n" +
  "<filter id=\"tg-ink-fountain\" x=\"-1%\" y=\"-5%\" width=\"102%\" height=\"110%\" color-interpolation-filters=\"sRGB\">\n" +
  "<feTurbulence type=\"fractalNoise\" baseFrequency=\"0.6\" numOctaves=\"2\" seed=\"7\" result=\"grain\"/>\n" +
  "<feDisplacementMap in=\"SourceGraphic\" in2=\"grain\" scale=\"1.3\" xChannelSelector=\"R\" yChannelSelector=\"G\" result=\"rough\"/>\n" +
  "<feTurbulence type=\"fractalNoise\" baseFrequency=\"0.03 0.07\" numOctaves=\"2\" seed=\"13\" result=\"flow\"/>\n" +
  "<feColorMatrix in=\"flow\" type=\"matrix\" values=\"0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -1.05 0 0 0 1.42\" result=\"density\"/>\n" +
  "<feComposite in=\"rough\" in2=\"density\" operator=\"in\" result=\"inked\"/>\n" +
  "<feGaussianBlur in=\"inked\" stdDeviation=\"0.55\" result=\"bleed\"/>\n" +
  "<feComponentTransfer in=\"bleed\" result=\"halo\"><feFuncA type=\"linear\" slope=\"0.7\"/></feComponentTransfer>\n" +
  "<feMerge><feMergeNode in=\"halo\"/><feMergeNode in=\"inked\"/><feMergeNode in=\"inked\"/></feMerge>\n" +
  "</filter>\n" +
  "<!-- Chalk on a board: dusty, broken strokes. -->\n" +
  "<filter id=\"tg-ink-chalk\" x=\"-1%\" y=\"-5%\" width=\"102%\" height=\"110%\" color-interpolation-filters=\"sRGB\">\n" +
  "<feTurbulence type=\"fractalNoise\" baseFrequency=\"1.1\" numOctaves=\"2\" seed=\"2\" result=\"grain\"/>\n" +
  "<feDisplacementMap in=\"SourceGraphic\" in2=\"grain\" scale=\"1.6\" xChannelSelector=\"R\" yChannelSelector=\"G\" result=\"rough\"/>\n" +
  "<feTurbulence type=\"fractalNoise\" baseFrequency=\"2.2\" numOctaves=\"1\" seed=\"9\" result=\"dust\"/>\n" +
  "<feColorMatrix in=\"dust\" type=\"matrix\" values=\"0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -1.6 0 0 0 1.75\" result=\"density\"/>\n" +
  "<feComposite in=\"rough\" in2=\"density\" operator=\"in\" result=\"chalked\"/>\n" +
  "<feGaussianBlur in=\"chalked\" stdDeviation=\"0.4\" result=\"dusty\"/>\n" +
  "<feComponentTransfer in=\"dusty\" result=\"haze\"><feFuncA type=\"linear\" slope=\"0.5\"/></feComponentTransfer>\n" +
  "<feMerge><feMergeNode in=\"haze\"/><feMergeNode in=\"chalked\"/></feMerge>\n" +
  "</filter>\n" +
  "</defs>\n" +
  "</svg>");
