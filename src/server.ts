import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Le coffre est monté en LECTURE SEULE dans ce conteneur (docker-compose.yml
// du cabinet, volume ":ro" sur /espace/coffre). Ce serveur ne fait qu'y lire :
// aucune route d'écriture n'existe ici, et le montage refuserait de toute
// façon toute tentative.
const RACINE = '/espace/coffre';

const DOSSIERS_IGNORES = new Set(['.git', '.obsidian', '.claude', '.trash', 'node_modules']);
const EXTENSIONS_IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

interface NoeudArbre {
  nom: string;
  chemin: string;
  type: 'dossier' | 'fichier';
  enfants?: NoeudArbre[];
}

// Résout un chemin relatif demandé par le client et vérifie qu'il reste sous
// RACINE, pour ne jamais servir un fichier hors du coffre (le reste du
// conteneur contient les jetons Claude, dans /home/node/.claude).
function resoudreChemin(relatif: string): string {
  const cible = path.normalize(path.join(RACINE, relatif));
  if (cible !== RACINE && !cible.startsWith(RACINE + path.sep)) {
    throw new Error('chemin hors du coffre');
  }
  return cible;
}

async function construireArbre(dir: string, relatif = ''): Promise<NoeudArbre[]> {
  const entrees = await fs.readdir(dir, { withFileTypes: true });
  const noeuds: NoeudArbre[] = [];
  const triees = entrees.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  for (const entree of triees) {
    if (entree.name.startsWith('.') || DOSSIERS_IGNORES.has(entree.name)) continue;
    const relEnfant = relatif ? `${relatif}/${entree.name}` : entree.name;
    if (entree.isDirectory()) {
      const enfants = await construireArbre(path.join(dir, entree.name), relEnfant);
      if (enfants.length > 0) {
        noeuds.push({ nom: entree.name, chemin: relEnfant, type: 'dossier', enfants });
      }
    } else {
      const ext = path.extname(entree.name).toLowerCase();
      if (ext === '.md' || EXTENSIONS_IMAGE.has(ext)) {
        noeuds.push({ nom: entree.name, chemin: relEnfant, type: 'fichier' });
      }
    }
  }
  return noeuds;
}

function envoyerJson(res: http.ServerResponse, statut: number, donnees: unknown) {
  res.writeHead(statut, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(donnees));
}

const serveur = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/arbre') {
      const arbre = await construireArbre(RACINE);
      envoyerJson(res, 200, { arbre });
      return;
    }

    if (url.pathname === '/note') {
      const rel = url.searchParams.get('chemin') ?? '';
      if (path.extname(rel).toLowerCase() !== '.md') throw new Error('pas une note markdown');
      const cible = resoudreChemin(rel);
      const contenu = await fs.readFile(cible, 'utf-8');
      envoyerJson(res, 200, { contenu });
      return;
    }

    if (url.pathname === '/media') {
      const rel = url.searchParams.get('chemin') ?? '';
      const ext = path.extname(rel).toLowerCase();
      if (!EXTENSIONS_IMAGE.has(ext)) throw new Error('pas une image');
      const cible = resoudreChemin(rel);
      const donnees = await fs.readFile(cible);
      envoyerJson(res, 200, { dataUrl: `data:${MIME[ext]};base64,${donnees.toString('base64')}` });
      return;
    }

    envoyerJson(res, 404, { erreur: 'route introuvable' });
  } catch (err) {
    envoyerJson(res, 400, { erreur: err instanceof Error ? err.message : 'erreur' });
  }
});

serveur.listen(0, '127.0.0.1', () => {
  const adresse = serveur.address();
  if (adresse && typeof adresse !== 'string') {
    console.log(JSON.stringify({ ready: true, port: adresse.port }));
  }
});
