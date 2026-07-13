import type { StarterPromptItem } from './starter-prompts';

export const STARTER_PROMPTS: readonly StarterPromptItem[] = [
  {
    title: 'Feedback form + dashboard',
    description: 'Collect responses and see live results',
    prompt: 'Build me a feedback form with a simple admin dashboard to view all submissions in real-time',
    icon: 'BarChart3',
  },
  {
    title: 'Internal admin panel',
    description: 'View and edit customer records',
    prompt: 'Create an internal admin panel where I can view, search, and edit customer data',
    icon: 'Shield',
  },
  {
    title: 'Webhook to Slack alerts',
    description: 'Stripe events → formatted messages',
    prompt: 'Set up a webhook endpoint that receives Stripe events and posts formatted notifications to a Slack channel',
    icon: 'Zap',
  },
  {
    title: 'Booking page',
    description: 'Let people grab time on your calendar',
    prompt: 'Build a booking page where visitors can see my availability, pick a slot, and get a calendar invite automatically',
    icon: 'Calendar',
  },
  {
    title: 'Waitlist with referrals',
    description: 'Track signups and who invited who',
    prompt: 'Create a waitlist page that gives each signup a unique referral link and shows their position in line',
    icon: 'Users',
  },
  {
    title: 'Changelog',
    description: 'Ship notes your users will actually read',
    prompt: 'Build a changelog page where I can post updates with dates, tags, and nice formatting',
    icon: 'Megaphone',
  },
  {
    title: 'Invoice generator',
    description: 'Pull from Stripe, email as PDF',
    prompt: 'Build an invoice generator that pulls customer and payment data from Stripe and lets me send branded PDF invoices',
    icon: 'Receipt',
  },
  {
    title: 'Status page',
    description: 'Show uptime, post incidents',
    prompt: 'Create a public status page for my API where I can post incidents and show current system health',
    icon: 'Activity',
  },
  {
    title: 'Team standup bot',
    description: 'Async check-ins, daily digest',
    prompt: 'Build a standup tool where my team submits daily updates and everyone gets a morning summary',
    icon: 'MessageCircle',
  },
  {
    title: 'Customer health dashboard',
    description: 'Usage signals across all your tools',
    prompt: 'Create a dashboard that pulls from Stripe, PostHog, and my database to show which customers are thriving vs at risk',
    icon: 'HeartPulse',
  },
  {
    title: 'Bug report portal',
    description: 'Intake, triage, track status',
    prompt: 'Build an internal bug reporting form that collects screenshots and details, with a board to track status',
    icon: 'Bug',
  },
  {
    title: 'Event RSVP page',
    description: 'Signups, cap, waitlist',
    prompt: 'Create an event page where people can RSVP, with a capacity limit and automatic waitlist when full',
    icon: 'Ticket',
  },
  {
    title: 'Content calendar',
    description: "Plan and track what you're shipping",
    prompt: 'Build a simple content calendar where I can plan posts, set publish dates, and mark things as done',
    icon: 'CalendarDays',
  },
  {
    title: 'Competitive intel tracker',
    description: 'Log what competitors ship',
    prompt: 'Create a simple tool where my team can log competitor updates with links, screenshots, and tags',
    icon: 'Eye',
  },
  {
    title: 'Simple poll',
    description: 'Quick vote, shareable link',
    prompt: 'Build a poll maker where I can create a question with options and share a link to collect votes',
    icon: 'Vote',
  },
  {
    title: 'Link in bio page',
    description: 'Your links + click analytics',
    prompt: 'Create a link-in-bio page where I can add links and see how many clicks each one gets',
    icon: 'Link',
  },
  {
    title: 'Chrome extension',
    description: 'Add superpowers to your browser',
    prompt: 'Build a Chrome extension that lets me save and pin anything I find on the internet to a personal collection',
    icon: 'Puzzle',
  },
  {
    title: 'Personal site',
    description: 'Your corner of the internet',
    prompt: 'Build me a personal website with my bio, work history, projects, and a way for people to get in touch',
    icon: 'Globe',
  },
  {
    title: 'Launch page',
    description: 'Build hype before you ship',
    prompt: 'Create a coming soon page for my product with a signup form, countdown timer, and social links',
    icon: 'Rocket',
  },
  {
    title: 'Report from CSV',
    description: 'Turn raw data into insights',
    prompt: 'Take this CSV and turn it into a clean report with charts, key metrics, and a summary I can share with my team',
    icon: 'FileSpreadsheet',
  },
  {
    title: 'Daily Wordle clone',
    description: 'A word game for your friends',
    prompt: 'Build a Wordle-style word guessing game with daily puzzles and a way to share my score',
    icon: 'Dices',
  },
  {
    title: 'Sudoku',
    description: 'Classic puzzle, fresh build',
    prompt: 'Create a Sudoku game with multiple difficulty levels, a timer, and the ability to check my progress',
    icon: 'Grid3x3',
  },
  {
    title: 'Meeting notes → action items',
    description: 'Paste transcript, get tasks',
    prompt: 'Build a tool where I paste meeting notes or a transcript and it extracts action items with owners and deadlines',
    icon: 'ListChecks',
  },
  {
    title: 'Price calculator',
    description: 'Interactive quote builder',
    prompt: 'Create a pricing calculator for my service where visitors can select options and see a live quote',
    icon: 'Calculator',
  },
];

export function pickStarterPrompts(
  allPrompts: readonly StarterPromptItem[],
  count: number,
  random: () => number = Math.random,
): StarterPromptItem[] {
  const copy = [...allPrompts];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy.slice(0, count);
}
