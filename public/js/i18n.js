const LABELS = {
  appName: 'Idea Generator',
  seedPlaceholder: 'Write an idea or paste a link … (Enter)',
  readingPage: 'Reading the page …',
  thinking: 'Thinking …',
  boards: 'Boards',
  newBoard: 'New board',
  goal: 'Goal',
  goalPlaceholder: 'e.g. innovative audio-visual product for interaction in public spaces',
  noGoal: 'No goal yet – click to set the direction',
  title: 'Name',
  template: 'Flow template',
  create: 'Create',
  cancel: 'Cancel',
  save: 'Save',
  close: 'Close',
  delete: 'Delete',
  manual: 'Manual',
  auto: 'Automatic',
  leads: 'Scouting',
  export: 'Export',
  boardSettings: 'Board settings',
  appSettings: 'Settings',
  fit: 'Show all',
  kind_seed: 'Seed', kind_expand: 'Branch', kind_combine: 'Cross',
  generation: 'generation {n}',
  notJudged: 'Not judged yet',
  judging: 'The jury is reading …',
  originality: 'Use', feasibility: 'Buildable', impact: 'Fit',
  expand: 'Branch out', expandHint: 'Three new ideas growing out of this one',
  combineWith: 'Cross with …', combinePick: 'Click the idea to cross with (Esc cancels). You can also drag one idea onto another.',
  rejudge: 'Judge again',
  medal: 'Medal', medalAuto: 'Jury',
  spinoff: 'New board from idea', spinoffHint: 'Refine the idea on a board of its own, with the idea as the goal',
  project: 'Claude Code project', projectHint: 'Create a project folder with a CLAUDE.md that Claude Code can start from',
  projectMaking: 'Writing the brief …',
  revealProject: 'Open folder', copyStart: 'Copy start command', copied: 'Copied',
  source: 'Source', spinoffs: 'Own boards', keywords: 'Keywords',
  deleteIdea: 'Delete idea', confirmDelete: 'Delete "{t}"?',
  overview: 'Overview', topIdeas: 'Top ideas', noIdeasYet: 'The board is empty. Write a seed below, or pull leads from the left panel.',
  evolution: 'Evolution', evoLine: 'Generation {g} · mean {first} → {latest} · best {best}', evoShort: 'Generation {g} · best {best}',
  summary: 'Summary', summarize: 'Summarize the board', resummarize: 'Refresh', summaryStale: '{n} new ideas since the summary',
  themes: 'Themes', strongest: 'Strongest', gaps: 'Gaps', nextSteps: 'Next steps',
  leadsX: 'X trends', leadsResearch: 'AI research', refresh: 'Fetch', refreshing: 'Scouting …',
  leadsEmpty: 'Nothing fetched yet. The scouts search from the board\'s goal.', addAsSeed: '+ Seed', onBoard: 'on the board',
  leadsDropped: '{n} leads without a verified source were dropped', leadsNone: 'No verified leads found this time',
  researcherOff: 'This scout is switched off in the board settings.',
  dragLead: 'Drag onto the board or click + Seed',
  findsEmpty: 'No finds from this source yet.', findUnscored: 'Unscored',
  findScore: 'Fit {n}', findSeeded: 'Seeded', findSource: 'Open source ↗',
  ap_manual: 'Manual', ap_running: 'Working …', ap_pace: 'Next step in {s}', ap_hourly: 'Hourly limit reached · resumes {time}',
  ap_board_budget: 'Daily budget spent · resumes tomorrow', ap_global_budget: 'Global daily budget spent · resumes tomorrow',
  ap_crew_cap: 'Crew daily limit reached · resumes tomorrow',
  ap_backoff: 'Error · retrying in {s}', ap_error: 'Error: {m}', ap_idle: 'Waiting', ap_idle_empty: 'Waiting for a seed',
  ap_idle_nothing: 'Nothing more to do right now',
  apMeta: '{n} steps in the last hour · ${usd} today',
  general: 'General', flow: 'Creation flow', flowName: 'Flow name',
  systemPrompt: 'Role (system prompt)', expandPrompt: 'Branching', combinePrompt: 'Crossing', applyTemplate: 'Use template',
  saveAsTemplate: 'Save as template', templateSaved: 'Template saved',
  jury: 'Jury', judgeGuidance: 'Extra guidance for the jury', judgeGuidancePh: 'e.g. Reward solutions that work outdoors all year.',
  autoProject: 'The jury turns gold ideas into Claude Code projects',
  researchers: 'Scouts', xScout: 'X trends (Grok via OpenRouter)', researchScout: 'AI research (Hugging Face)', focus: 'Extra focus',
  focusPh: 'besides the goal, e.g. "sound installations"',
  autopilot: 'Autopilot', mode: 'Mode', pace: 'Seconds between steps', stepsPerHour: 'Max steps per hour', usdPerDay: 'Max USD per day',
  rateNote: 'The autopilot checks recorded spend before starting a step.',
  models: 'Models', modelsBoardNote: 'Empty field = the app setting.',
  role_distill: 'Distill seed', role_expand: 'Branch', role_combine: 'Cross', role_judge: 'Jury', role_summary: 'Summarize',
  role_research: 'Research scout', role_x: 'X scout', role_brief: 'Project brief', role_deep: 'Daily deep cross', role_exists: 'Already-exists check',
  crewCallsPerDay: 'Crew calls per day',
  alreadyExists: 'Already exists', existsPartial: 'Related tool exists', existsNew: 'Checked: new idea',
  deleteBoard: 'Delete board', confirmDeleteBoard: 'Delete the board "{t}" with all its ideas?',
  providers: 'Providers', test: 'Test', testOk: '{n} models',
  keyFrom_env: 'Key from environment', keyMissing: 'No key',
  projectsRoot: 'Folder for Claude Code projects', globalBudget: 'Global limit, USD per day', spend: 'Spent: ${today} today · ${total} in total',
  settingsNote: 'Settings are saved on the server. Set provider keys through the environment variables below.',
  activeStart: 'Start time (local)', activeEnd: 'End time (local)',
  ap_night: 'Outside active hours · resumes {time}',
  settingsSaved: 'Settings saved',
  needKey: 'Set {env} to use {p}.',
  calibrateNote: 'Changing the jury model? Run npm run calibrate -- --model <model> to check it still tells weak from strong.',
  days: '{n} days', statIdeas: 'Ideas',
  report: 'Report', reportNew: '{n} new', reportMedals: 'Medals', reportProjects: 'Claude Code projects',
  reportSpent: 'Spent, {n} days', conclusions: 'Conclusions', writeConclusions: 'Write conclusions',
  rewriteConclusions: 'Rewrite', conclusionsHint: 'Let the AI read every board and write the conclusions: insights, the ideas most worth pursuing, opportunities and next steps.',
  conclusionsFrom: 'Written {date} · covered {n} days', insights: 'Insights', standouts: 'Most worth pursuing', opportunities: 'Opportunities',
  noProjects: 'No projects yet. Gold ideas become projects by themselves, or click → Claude Code project on an idea.',
  ideasWord: 'ideas', summaryOld: 'older than the board', noBoardSummary: 'No summary yet.',
  gold: '🥇 Gold: {t}', projectCreated: 'Claude Code project created: {p}',
  err_no_key: 'No API key: {m}', err_bad_key: 'The key was not accepted: {m}', err_unreachable: 'Cannot reach the service: {m}',
  err_no_search: '{m}', err_url_unreadable: 'Could not read the link: {m}', err_url_no_text: 'The page has too little readable text.',
  err_too_few: 'The summary needs at least two ideas.', err_crew_signin: 'Crew sign-in expired: {m}',
  err_crew_timeout: 'Crew timed out: {m}', err_no_crew_path: '{m}', err_crew_cap: '{m}',
  err_generic: 'Something went wrong: {m}',
  firstRun: 'Welcome! Start with a board and a goal.',
};

export function t(key, vars = {}) {
  let s = LABELS[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Fill [data-i18n] text, [data-i18n-ph] placeholders and [data-i18n-title] tooltips. */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute('aria-label', el.title);
  }
}

/** A friendly message for an API error code. */
export function errorText(e) {
  const key = `err_${e?.code}`;
  return LABELS[key] ? t(key, { m: e.message }) : t('err_generic', { m: e?.message ?? String(e) });
}
