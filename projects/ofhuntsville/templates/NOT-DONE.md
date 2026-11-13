# Not done yet — {{project.title}}

Run {{run.id}}. Origin: `{{targets.origin.host}}`. Edge: `{{targets.edge.host}}` ({{edge.ip}}).

## 1. Point the subdomains at the edge (tonight)

- [ ] At the current DNS host for {{root.domain}}, add `*.{{root.domain}}  A  {{edge.ip}}`. Keep the apex and www on Netlify.

## 2. The origin port

- [ ] Port {{origin.port}} on the origin must be reachable from the edge. Best: allow only {{edge.ip}} in the origin's firewall.

## 3. Later: hand the whole zone to PowerDNS (optional)

- [ ] Copy any MX/TXT records from the current DNS host into the manager's DNS tab first.
- [ ] At the registrar, set glue `ns1`/`ns2.{{root.domain}}` → {{edge.ip}}, then switch nameservers to them.

## 4. Deploy key

- [ ] Each server needs read access to the ofhuntsville repo (deploy key, or set git.token).
