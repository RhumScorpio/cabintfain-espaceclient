import type { PluginAPI, PluginContext, NoeudArbre } from './types.js';
import { rendreMarkdown, type ResoudreLien } from './markdown.js';

function couleurs(theme: PluginContext['theme']) {
  return theme === 'light'
    ? { fond: '#ffffff', panneau: '#f7f7f7', texte: '#1a1a1a', sousTexte: '#5a5a5a', bordure: '#d9d9d9', accent: '#2563eb', erreur: '#dc2626' }
    : { fond: '#1e1e1e', panneau: '#242424', texte: '#f0f0f0', sousTexte: '#a0a0a0', bordure: '#3a3a3a', accent: '#60a5fa', erreur: '#f87171' };
}

// Index basename → nœuds, pour résoudre les wikiliens qui ne donnent que le
// nom de la note, sans dossier (usage le plus courant dans ce coffre).
function aplatir(noeuds: NoeudArbre[], acc: Map<string, NoeudArbre[]>) {
  for (const n of noeuds) {
    if (n.type === 'fichier') {
      const base = n.nom.replace(/\.[^.]+$/, '').toLowerCase();
      const liste = acc.get(base) ?? [];
      liste.push(n);
      acc.set(base, liste);
    }
    if (n.enfants) aplatir(n.enfants, acc);
  }
}

export async function mount(container: HTMLElement, api: PluginAPI): Promise<void> {
  const c = couleurs(api.context.theme);

  container.innerHTML = '';
  container.style.display = 'flex';
  container.style.height = '100%';
  container.style.color = c.texte;
  container.style.fontSize = '14px';
  container.style.lineHeight = '1.5';

  const panneauArbre = document.createElement('div');
  panneauArbre.style.width = '280px';
  panneauArbre.style.flexShrink = '0';
  panneauArbre.style.overflowY = 'auto';
  panneauArbre.style.borderRight = `1px solid ${c.bordure}`;
  panneauArbre.style.background = c.panneau;
  panneauArbre.style.padding = '8px';

  const panneauNote = document.createElement('div');
  panneauNote.style.flex = '1';
  panneauNote.style.overflowY = 'auto';
  panneauNote.style.padding = '16px 24px';

  const mention = document.createElement('div');
  mention.textContent = 'Coffre — consultation seule';
  mention.style.color = c.sousTexte;
  mention.style.fontSize = '12px';
  mention.style.padding = '4px 8px 12px';
  panneauArbre.appendChild(mention);

  container.appendChild(panneauArbre);
  container.appendChild(panneauNote);
  panneauNote.innerHTML = '<p>Chargement du coffre…</p>';

  let arbre: NoeudArbre[] = [];
  const index = new Map<string, NoeudArbre[]>();

  try {
    const reponse = (await api.rpc('GET', '/arbre')) as { arbre: NoeudArbre[] };
    arbre = reponse.arbre;
    aplatir(arbre, index);
  } catch (err) {
    panneauNote.innerHTML = `<p style="color:${c.erreur}">Impossible de charger le coffre : ${err instanceof Error ? err.message : String(err)}</p>`;
    return;
  }

  const resoudre: ResoudreLien = (cible) => {
    const baseNom = cible.split('/').pop() ?? cible;
    const aExtension = /\.[a-z0-9]+$/i.test(baseNom);
    const propre = cible.replace(/\.[a-z0-9]+$/i, '');

    if (cible.includes('/')) {
      for (const liste of index.values()) {
        for (const n of liste) {
          const cheminSansExt = n.chemin.replace(/\.[a-z0-9]+$/i, '');
          if (cheminSansExt.toLowerCase() === propre.toLowerCase() || cheminSansExt.toLowerCase().endsWith(`/${propre.toLowerCase()}`)) {
            return { chemin: n.chemin, titre: n.nom.replace(/\.[a-z0-9]+$/i, '') };
          }
        }
      }
    }

    const base = baseNom.replace(/\.[a-z0-9]+$/i, '').toLowerCase();
    const candidats = index.get(base) ?? [];
    const choix = aExtension
      ? candidats.find((n) => n.nom.toLowerCase() === baseNom.toLowerCase())
      : candidats.find((n) => n.nom.toLowerCase().endsWith('.md')) ?? candidats[0];
    if (choix) return { chemin: choix.chemin, titre: choix.nom.replace(/\.[a-z0-9]+$/i, '') };
    return null;
  };

  async function ouvrirNote(chemin: string) {
    panneauNote.innerHTML = '<p>Chargement…</p>';
    try {
      const reponse = (await api.rpc('GET', `/note?chemin=${encodeURIComponent(chemin)}`)) as { contenu: string };
      panneauNote.innerHTML = rendreMarkdown(reponse.contenu, resoudre);
      panneauNote.scrollTop = 0;

      panneauNote.querySelectorAll<HTMLAnchorElement>('a.wikilien').forEach((a) => {
        a.style.color = c.accent;
        a.style.cursor = 'pointer';
        a.style.textDecoration = 'none';
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          const cibleChemin = decodeURIComponent(a.dataset.chemin ?? '');
          if (cibleChemin) void ouvrirNote(cibleChemin);
        });
      });

      panneauNote.querySelectorAll<HTMLElement>('.wikilien-mort').forEach((s) => {
        s.style.color = c.erreur;
        s.style.borderBottom = `1px dotted ${c.erreur}`;
      });

      panneauNote.querySelectorAll<HTMLElement>('.embed-image').forEach((s) => {
        const cibleEmbed = decodeURIComponent(s.dataset.embed ?? '');
        const res = resoudre(cibleEmbed);
        const cheminReel = res?.chemin ?? cibleEmbed;
        api
          .rpc('GET', `/media?chemin=${encodeURIComponent(cheminReel)}`)
          .then((r) => {
            const img = document.createElement('img');
            img.src = (r as { dataUrl: string }).dataUrl;
            img.alt = cibleEmbed;
            img.style.maxWidth = '100%';
            s.replaceWith(img);
          })
          .catch(() => {
            s.textContent = `[image introuvable : ${cibleEmbed}]`;
            s.style.color = c.erreur;
          });
      });
    } catch (err) {
      panneauNote.innerHTML = `<p style="color:${c.erreur}">Impossible d'ouvrir cette note : ${err instanceof Error ? err.message : String(err)}</p>`;
    }
  }

  function construireArbreDom(noeuds: NoeudArbre[]): HTMLElement {
    const liste = document.createElement('ul');
    liste.style.listStyle = 'none';
    liste.style.margin = '0';
    liste.style.paddingLeft = '14px';
    for (const n of noeuds) {
      const item = document.createElement('li');
      if (n.type === 'dossier') {
        const bouton = document.createElement('div');
        bouton.textContent = `📁 ${n.nom}`;
        bouton.style.cursor = 'pointer';
        bouton.style.padding = '3px 0';
        const sousListe = n.enfants ? construireArbreDom(n.enfants) : null;
        if (sousListe) sousListe.style.display = 'none';
        bouton.addEventListener('click', () => {
          if (sousListe) sousListe.style.display = sousListe.style.display === 'none' ? 'block' : 'none';
        });
        item.appendChild(bouton);
        if (sousListe) item.appendChild(sousListe);
      } else {
        const estMd = n.nom.toLowerCase().endsWith('.md');
        const ligneFichier = document.createElement('div');
        ligneFichier.textContent = `${estMd ? '📄' : '🖼️'} ${n.nom}`;
        ligneFichier.style.padding = '3px 0';
        ligneFichier.style.color = estMd ? c.texte : c.sousTexte;
        ligneFichier.style.cursor = estMd ? 'pointer' : 'default';
        if (estMd) ligneFichier.addEventListener('click', () => void ouvrirNote(n.chemin));
        item.appendChild(ligneFichier);
      }
      liste.appendChild(item);
    }
    return liste;
  }

  panneauArbre.appendChild(construireArbreDom(arbre));
  panneauNote.innerHTML = "<p>Choisissez une note dans l'arborescence, à gauche.</p>";
}

export function unmount(container: HTMLElement): void {
  container.innerHTML = '';
}
