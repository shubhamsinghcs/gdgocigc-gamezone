/**
 * js/questions.js
 * 25-question JSON dataset array
 */

export const questionsData = [
  {
    id: 1,
    category: 'Latest Tech News',
    question: 'Which company officially released the Gemini 1.5 Pro and open-weights Gemma models family?',
    options: ['Microsoft', 'Google', 'Meta', 'Anthropic'],
    correctIndex: 1,
    explanation: 'Google released Gemini 1.5 Pro with million-token context window alongside Gemma open models.'
  },
  {
    id: 2,
    category: 'Latest Tech News',
    question: 'In quantum computing, what landmark milestone describes a quantum processor outperforming classical supercomputers?',
    options: ['Quantum Supremacy', 'Quantum Entanglement', 'Qubit Coherence', 'Cryogenic Breakthrough'],
    correctIndex: 0,
    explanation: 'Quantum Supremacy describes quantum hardware solving a calculation in seconds that takes classical computers millennia.'
  },
  {
    id: 3,
    category: 'Latest Tech News',
    question: 'Which open-standard instruction set architecture (ISA) has surged globally as a royalty-free alternative to ARM and x86?',
    options: ['MIPS-IV', 'SPARC', 'RISC-V', 'OpenPOWER'],
    correctIndex: 2,
    explanation: 'RISC-V is an open, modular ISA rapidly adopted across automotive, IoT, and high-performance server silicon.'
  },
  {
    id: 4,
    category: 'Latest Tech News',
    question: 'What advanced packaging method vertically stacks multiple silicon dies using Through-Silicon Vias (TSVs)?',
    options: ['Planar Lithography', '3D Chiplet Stacking', 'Wire Bonding', 'Surface Mount Dual In-Line'],
    correctIndex: 1,
    explanation: '3D Chiplet Stacking (like CoWoS and Foveros) stacks compute and HBM memory vertically with microscopic TSVs.'
  },
  {
    id: 5,
    category: 'Latest Tech News',
    question: 'Which open-source browser engine now underlies both Google Chrome and modern Microsoft Edge?',
    options: ['Gecko', 'WebKit', 'Chromium (Blink)', 'Trident'],
    correctIndex: 2,
    explanation: 'Microsoft Edge switched to the Chromium open-source base powered by the Blink rendering engine.'
  },
  {
    id: 6,
    category: 'Emoji Language IDs',
    question: 'Identify the language: 🐍 📦 🚀 (Hint: Supreme for Machine Learning, Data Science & Clean Indentation)',
    options: ['Python', 'Ruby', 'Swift', 'Perl'],
    correctIndex: 0,
    explanation: 'Python uses the snake emoji 🐍 and is ubiquitous in machine learning and data engineering.'
  },
  {
    id: 7,
    category: 'Emoji Language IDs',
    question: 'Identify the language: 🦀 ⚡ 🛡️ (Hint: Memory-safe systems programming without a garbage collector)',
    options: ['C++', 'Rust', 'Zig', 'Go'],
    correctIndex: 1,
    explanation: 'Rust is symbolized by Ferris the Crab 🦀 and renowned for compiler borrow-checking safety.'
  },
  {
    id: 8,
    category: 'Emoji Language IDs',
    question: 'Identify the language: ☕ ♨️ 🏢 (Hint: "Write Once, Run Anywhere" enterprise JVM foundation)',
    options: ['JavaScript', 'Java', 'Kotlin', 'Scala'],
    correctIndex: 1,
    explanation: 'Java features the iconic steaming coffee cup logo ☕ and powers billions of enterprise devices.'
  },
  {
    id: 9,
    category: 'Emoji Language IDs',
    question: 'Identify the language: 🐘 🌐 💾 (Hint: Powers WordPress, Wikipedia, and 75%+ of web backends)',
    options: ['PHP', 'C#', 'Dart', 'Elixir'],
    correctIndex: 0,
    explanation: 'PHP is famously symbolized by the blue elePHPant 🐘 mascot.'
  },
  {
    id: 10,
    category: 'Emoji Language IDs',
    question: 'Identify the frontend framework / ecosystem: ⚛️ ⚡ 🔷 (Hint: Declarative Virtual DOM library by Meta)',
    options: ['Vue.js', 'Angular', 'React', 'Svelte'],
    correctIndex: 2,
    explanation: 'React uses the science atom symbol ⚛️ as its official emblem.'
  },
  {
    id: 11,
    category: 'Tech Basics',
    question: 'Which HTTP response status code officially designates "Moved Permanently"?',
    options: ['200 OK', '301 Moved Permanently', '404 Not Found', '503 Service Unavailable'],
    correctIndex: 1,
    explanation: 'HTTP 301 informs search engines and clients that the resource permanently relocated to a new URI.'
  },
  {
    id: 12,
    category: 'Tech Basics',
    question: 'What networking protocol resolves human-friendly URLs to computer numerical IP addresses?',
    options: ['DHCP', 'DNS', 'ARP', 'SNMP'],
    correctIndex: 1,
    explanation: 'DNS (Domain Name System) functions as the phonebook of the global Internet.'
  },
  {
    id: 13,
    category: 'Tech Basics',
    question: 'What is the worst-case time complexity of standard QuickSort when an unfortunate pivot is chosen?',
    options: ['O(log n)', 'O(n)', 'O(n log n)', 'O(n²)'],
    correctIndex: 3,
    explanation: 'Without randomized or median-of-three pivots, an already sorted array can degrade QuickSort to O(n²).'
  },
  {
    id: 14,
    category: 'AI & Deep Learning',
    question: 'Which deep learning architecture introduced Multi-Head Self-Attention in "Attention Is All You Need"?',
    options: ['Convolutional Neural Network (CNN)', 'Recurrent Neural Network (RNN)', 'Transformer', 'Boltzmann Machine'],
    correctIndex: 2,
    explanation: 'Vaswani et al. introduced the Transformer architecture in 2017, foundational to modern LLMs.'
  },
  {
    id: 15,
    category: 'Hardware & IoT',
    question: 'Which sensor fires rapid laser pulses to calculate distance and produce dense 3D point cloud maps on drones?',
    options: ['LiDAR', 'Sonar', 'Barometer', 'Magnetometer'],
    correctIndex: 0,
    explanation: 'LiDAR (Light Detection and Ranging) accurately maps 3D terrain and obstacles in real-time.'
  },
  {
    id: 16,
    category: 'AI Alignment',
    question: 'In modern generative AI post-training alignment, what does the acronym "RLHF" stand for?',
    options: [
      'Recursive Learning for High Frequency',
      'Reinforcement Learning from Human Feedback',
      'Robust Logic and Heuristic Filtering',
      'Randomized Latent Hyperparameter Fine-tuning'
    ],
    correctIndex: 1,
    explanation: 'RLHF aligns LLMs with human preference by training reward models on human judgments.'
  },
  {
    id: 17,
    category: 'Cloud & DevOps',
    question: 'Which CNCF container orchestration system has become the industry standard for deploying containerized clusters?',
    options: ['Docker Swarm', 'Kubernetes', 'Apache Mesos', 'Nomad'],
    correctIndex: 1,
    explanation: 'Kubernetes automates container deployment, scaling, and operations across cluster nodes.'
  },
  {
    id: 18,
    category: 'Cybersecurity',
    question: 'What cryptographic protocol secures communications over computer networks, succeeding SSL?',
    options: ['TLS (Transport Layer Security)', 'FTP Secure', 'SSH Tunnel', 'IPSec Cipher'],
    correctIndex: 0,
    explanation: 'TLS secures web traffic (HTTPS), providing encryption, authentication, and data integrity.'
  },
  {
    id: 19,
    category: 'Database Systems',
    question: 'Which database design principle guarantees ACID compliance in relational database management systems?',
    options: ['Eventual Consistency', 'Transactions', 'Sharding', 'NoSQL Document Store'],
    correctIndex: 1,
    explanation: 'Transactions ensure Atomicity, Consistency, Isolation, and Durability in relational databases.'
  },
  {
    id: 20,
    category: 'Web Standards',
    question: 'What markup language structure is used by browsers to represent the page document object hierarchy?',
    options: ['DOM (Document Object Model)', 'XML Stream', 'JSON Tree', 'JSX Virtual Node'],
    correctIndex: 0,
    explanation: 'The DOM represents the page so that programs can change document structure, style, and content.'
  },
  {
    id: 21,
    category: 'Mobile Engineering',
    question: 'Which cross-platform mobile app framework was created by Google using the Dart programming language?',
    options: ['React Native', 'Flutter', 'Xamarin', 'Ionic'],
    correctIndex: 1,
    explanation: 'Flutter allows developers to build natively compiled applications for mobile, web, and desktop from a single codebase.'
  },
  {
    id: 22,
    category: 'Version Control',
    question: 'Which Git command downloads a repository from a remote source along with all its history and branches?',
    options: ['git push', 'git commit', 'git clone', 'git fetch'],
    correctIndex: 2,
    explanation: 'git clone creates a local copy of a remote repository including all revision histories.'
  },
  {
    id: 23,
    category: 'Data Structures',
    question: 'Which linear data structure operates on a Last-In, First-Out (LIFO) principle?',
    options: ['Queue', 'Stack', 'Array', 'Linked List'],
    correctIndex: 1,
    explanation: 'A Stack pushes and pops elements from the same end, following Last-In, First-Out order.'
  },
  {
    id: 24,
    category: 'Operating Systems',
    question: 'What core component of an operating system manages system hardware and process execution?',
    options: ['Shell', 'Kernel', 'Daemon', 'Compiler'],
    correctIndex: 1,
    explanation: 'The kernel is the core central computer program that bridges applications and data processing at the hardware level.'
  },
  {
    id: 25,
    category: 'GDGoC Community',
    question: 'What does GDGoC stand for in Google Developer communities worldwide?',
    options: [
      'Google Developer Group on Campus',
      'Global Digital Growth of Code',
      'Google Data General Operations Center',
      'General Developer Guild of California'
    ],
    correctIndex: 0,
    explanation: 'GDGoC stands for Google Developer Groups on Campus, fostering student developer innovation.'
  }
];

export function getActiveQuestions(gameStateQuestions) {
  if (gameStateQuestions && Array.isArray(gameStateQuestions) && gameStateQuestions.length > 0) {
    return gameStateQuestions;
  }
  return questionsData;
}
