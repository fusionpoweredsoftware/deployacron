# Not done yet — {{project.title}}

Run: {{run.id}}. The deployer pushed `{{source.dir}}` to `{{server.user}}@{{server.host}}:{{server.remoteDir}}`
and ran the install step. What is still by hand:

## 1. Starting it for good

- [ ] {{app.name}} needs a service definition on the server so it survives a reboot.

## 2. Reaching it

- [ ] Route a hostname to :{{app.port}} on the box (reverse proxy, tunnel, or firewall rule).
