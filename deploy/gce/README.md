# Deploy to the GCE VM `tariff-order` (asia-south2-b)

This deployment puts the whole dashboard, including Round the Clock and the FastAPI backend,
on port 80 with no login. nginx sits in front of uvicorn, and systemd restarts the app on
failure and on reboot. The VM needs about 2 GB RAM (e2-small or larger) for the build.

## 1. Give the VM a public IP and open port 80 (run once, in Cloud Shell)

```sh
ZONE=asia-south2-b
# Static external IP (the VM currently has only an internal IP)
gcloud compute addresses create fdre-ip --region asia-south2
gcloud compute instances add-access-config tariff-order --zone $ZONE \
  --address "$(gcloud compute addresses describe fdre-ip --region asia-south2 --format='value(address)')"

# Allow HTTP from anywhere
gcloud compute instances add-tags tariff-order --zone $ZONE --tags http-server
gcloud compute firewall-rules create allow-http-80 --allow tcp:80 \
  --target-tags http-server --source-ranges 0.0.0.0/0   # skip if it already exists
```

## 2. Install the app on the VM

```sh
gcloud compute ssh tariff-order --zone asia-south2-b    # or the SSH button in the console
# on the VM:
git clone -b claude/intelligent-carson-mwonct https://github.com/Ergplan/FDRE.git fdre
cd fdre
sudo bash deploy/gce/install.sh
```

The repository is private, so `git clone` asks for a GitHub username and a personal access
token with read access. A read-only deploy key also works.

Open `http://<external IP>/`.

## Update

```sh
cd ~/fdre && git pull && sudo bash deploy/gce/install.sh
```

## Operate

```sh
sudo systemctl status fdre          # app status
sudo journalctl -u fdre -f          # app logs
sudo systemctl restart fdre
```

The page is public: anyone with the IP can use it. To restrict it later, narrow
`--source-ranges` on the firewall rule to your office IPs.
