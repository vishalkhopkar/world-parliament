// Preset party colours and symbols (docx: preset library for both; avatars come later).
// Symbols are generic and deliberately avoid real party symbols. Ids map to lucide icons in the web app.

export const PARTY_COLOURS: { id: string; hex: string; label: string }[] = [
  { id: 'saffron', hex: '#E8710A', label: 'Saffron' },
  { id: 'blue', hex: '#1F5FBF', label: 'Blue' },
  { id: 'green', hex: '#1E8C45', label: 'Green' },
  { id: 'crimson', hex: '#C0182F', label: 'Crimson' },
  { id: 'purple', hex: '#7B3FB5', label: 'Purple' },
  { id: 'teal', hex: '#0F8B8D', label: 'Teal' },
  { id: 'gold', hex: '#C9A400', label: 'Gold' },
  { id: 'magenta', hex: '#C2187A', label: 'Magenta' },
  { id: 'brown', hex: '#7A4A1E', label: 'Brown' },
  { id: 'navy', hex: '#14285A', label: 'Navy' },
  { id: 'lime', hex: '#7DB31A', label: 'Lime' },
  { id: 'slate', hex: '#4A5A6A', label: 'Slate' },
];

export const PARTY_SYMBOLS: { id: string; label: string; icon: string }[] = [
  { id: 'anchor', label: 'Anchor', icon: 'Anchor' },
  { id: 'key', label: 'Key', icon: 'KeyRound' },
  { id: 'globe', label: 'Globe', icon: 'Globe' },
  { id: 'leaf', label: 'Leaf', icon: 'Leaf' },
  { id: 'mountain', label: 'Mountain', icon: 'Mountain' },
  { id: 'scales', label: 'Scales', icon: 'Scale' },
  { id: 'torch', label: 'Torch', icon: 'Flame' },
  { id: 'sun', label: 'Sun', icon: 'Sun' },
  { id: 'star', label: 'Star', icon: 'Star' },
  { id: 'tree', label: 'Tree', icon: 'TreePine' },
  { id: 'bell', label: 'Bell', icon: 'Bell' },
  { id: 'book', label: 'Book', icon: 'BookOpen' },
  { id: 'umbrella', label: 'Umbrella', icon: 'Umbrella' },
  { id: 'feather', label: 'Feather', icon: 'Feather' },
  { id: 'compass', label: 'Compass', icon: 'Compass' },
  { id: 'rocket', label: 'Rocket', icon: 'Rocket' },
];
