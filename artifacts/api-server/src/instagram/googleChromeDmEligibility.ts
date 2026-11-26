/** Conservative name conventions, not identity or gender verification.
 * Unknown first names fail closed instead of passing an incomplete blocklist.
 */
const normalize = (value: string) =>
  value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const words = (value: string) => normalize(value).match(/\p{L}+/gu) ?? [];

const maleNames = new Set(words(`
aaron abdul abdullah abraham adam adnan ahmad ahmed alan albert alexander alejandro
alexandre alessandro alexis ali amir andre andrea andreas andrew andrei andrey
anthony anton antonio arjun arthur asif austin ayaan aziz bailey ben benjamin bilal
blake bradley brandon brian bruce caleb cameron carl carlos charles charlie chris
christian christopher cody colin connor craig daniel david diego dmitri dmitry
dylan eduardo edward elijah elliot elliott emmanuel enrique eric ethan eugene
evan faisal farhan frank francois francisco gabriel gary gavin george georgios
gerard gregory guillermo gustavo hamza hassan harry henry hugo ibrahim igor
imran isaac ismail ivan jack jacob jake james jared jason jean jeffrey jeremy
jesse joao joaquin joe joel johan johann johannes john jonathan jorge jose
joseph joshua juan julian justin kareem karl keith kenneth kevin khalid
kyle lawrence leo liam logan louis lucas luca luigi luis luke lukas malik manuel
marc marco marcos marcus mario mark martin mason mateo mathieu matteo matthew
max maxim maximilian mehmet michael michel miguel mikhail milan mohamed mohammad
mohammed muhammad murat musa mustafa nathan nathaniel neil nicholas nicolas nikita
nikolai nikolas noah omar oliver oscar osman owen pablo patrick paul paulo pedro
peter philip philippe pierre piotr rafael rahul raj rajesh rakesh ramon raymond
ricardo richard robert roberto rodrigo roman ronald ryan samir samuel santiago
scott sean sebastian sebastien sergei sergey sergio seth shane simon stefan stephen
steve steven stuart taha tariq thomas timothy tomas tony tyler umar victor vincent
vladimir walter wayne william wojciech wyatt xavier yusuf yuri yury zachary zain zayn
محمد احمد أحمد محمود مصطفى يوسف عمر علي خالد حسن حسين ابراهيم إبراهيم عبدالله
أлександр александр алексей андрей дмитрий иван сергей сергий николай михаил
павел владимир виктор борис петр пётр юрий
`));
const femaleNames = new Set(words(`
abigail ada adela adelaide adele adriana agata agnes aisha aishah aissatou
alessia alexandra alexandria alice alicia alina alisa alison aliyah alyssa
amanda amelia amelie amina amy ana anabel anastasia anastasiya angela angelica
angelina anita anjali anna annabelle anne annette anouk antonia anya ariana
arianna arina asha ashley audrey aurelia aurora ava ayesha aylin aziza
barbara beatrice beatriz bella bernadette beth bethany bianca blanca brenda
camila camilla carla carmen carolina caroline cassandra catherine cecilia
celeste celine charlotte chloe christina christine cindy clara clarissa
claudia cleo colette constance coralie cristina cynthia daisy daniela
danielle daphne daria deborah delia delilah denise diana diane dolly donna
dorothy elaine eleanor elena eleonora elisa elisabeth elise eliza elizabeth
ella elle ellen eloise elsa emilia emilie emily emma erica erin esme
esperanza estelle esther eva evelina evelyn fabienne farah fatima fatou
felicia felicity fiona flora florence francesca gabriela gabriella gabrielle
gemma genevieve georgia georgina gianna gillian gina giorgia giovanna giselle
gloria grace greta hafsa hannah hana harriet haven hazel heather helen helena
heloise henrietta holly ida ines ingrid irene iris isabel isabella isabelle
isadora isla ivy jacqueline jade jamila jane janet janice jasmine jennifer
jenny jessica jill joanna joanne jocelyn josephine joy joyce juana judith
julia juliana julie juliet juliette june justine kalina kamila karina
karolina katarina katherine kathleen kathryn katie katrina kayla keira
khadija kiara kirsten kristen kristina lana laura lauren layla leah leila
lena leonie leticia lila lilian liliana lillian lily lina linda lisa liv
livia lola lorena louisa louise lucia luciana lucie lucille lucy luisa
lydia madeleine madeline magdalena maisie malika mandy manon margaret
margarita margot maria mariam mariana marianne marie marilyn marina marisol
marjorie marlene marta martha martina mary mathilde maureen maya melanie
melina melissa mia michaela michelle mila milena mina miranda mireille
miriam molly monica monique nadia naima nancy naomi natalia natalie
natasha nathalie nicole nina noelia noelle nora نورا noura olga olivia
paola patricia paula pauline penelope phoebe priscilla rachel rafaela
raquel rebecca regina renata rita roberta rosa rosalie rose rosemary
roxana ruby sabina sabine sabrina sadaf safiya salma samantha sandra
sara sarah saskia savannah scarlett selena serena sharon sheila simona
simone sofia sofie sophia sophie stella stephanie susan susanna susanne
susie suzanne sylvia sylvie tabitha tamara tania tara tatiana teresa
theresa tiffany valentina valeria vanessa vera veronica victoria viola
violet virginia vivian viviana vivienne wendy yasmin yasmine yelena
yolanda yulia yvonne zahra zara zeynep zoe zoey
анна аннастаcия анастасия елена ольга наталья наталия мария ирина татьяна
екатерина юлия светлана дарья полина софия алина валентина виктория
فاطمة فاطمه عائشة عايشة مريم خديجة سارة ساره زينب ليلى سلمى ياسمين
`));
const businessWords = new Set(words(`
business shop store boutique salon studio official page fan fans club community
girls boys world around content creator agency services service consulting
restaurant cafe mechanic mecanique motors auto cars fitness clothing jewellery
jewelry beauty cosmetics photography realty realestate estate travel hotel
entertainment music band records news media marketing onlyfans promo promotions
sonorense sierreno
ltd limited inc llc company corporation corp group team
`));

export function hasGoogleChromeDmPhoto(url?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) &&
      !/(?:rsrc\.php|silhouette|default[_/-]?(?:avatar|profile)|(?:blank|default)[_-]?user|placeholder|s160x160\/.*(?:10354686_10150004552801856|84628273_176159830277856))/i.test(parsed.href);
  } catch { return false; }
}

export function googleChromeGirlsOnlyRejection(candidate: { name: string; photoUrl?: string }): string | null {
  const name = candidate.name.trim();
  // Whitespace defines name parts; apostrophes/hyphens within a part are allowed.
  const parts = name.split(/\s+/u);
  if (parts.length < 1 || parts.length > 2 ||
      parts.some(part => !/^\p{L}[\p{L}\p{M}]*(?:['’ʼ-]\p{L}[\p{L}\p{M}]*)*$/u.test(part))) {
    return "Requires one or two personal-name parts without numbers, symbols or promotional text.";
  }
  const tokens = words(name);
  if (tokens.some(token => maleNames.has(token))) return "Known male or ambiguous name; skipped.";
  if (tokens.some(token => businessWords.has(token))) return "Business or promotional name; skipped.";
  const firstName = words(parts[0]);
  if (!firstName.length || !firstName.every(token => femaleNames.has(token))) {
    return "First name is not positively recognised by the female-name rules; skipped.";
  }
  if (!hasGoogleChromeDmPhoto(candidate.photoUrl)) return "A loaded, non-placeholder profile picture is required.";
  return null;
}
