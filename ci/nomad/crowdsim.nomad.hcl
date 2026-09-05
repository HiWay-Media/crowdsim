# crowdsim as a Nomad PARAMETERIZED BATCH job.
#
# Why batch and not service: a load test is a bounded run with an outcome, not something that should be
# kept alive and restarted. A `service` job that restarts on exit would re-fire load at your production
# every time the brake trips — the exact opposite of what the brake is for.
#
# Why parameterized: the target, the rate and the duration change every run, and they belong in the
# dispatch call (which is logged and attributable) rather than in a committed job file.
#
#   nomad job run crowdsim.nomad.hcl
#   nomad job dispatch \
#     -meta target=edge -meta peak=120 -meta hold=120s -meta profile_url=... crowdsim
#
# ⚠️ Placement matters more than it looks. Put the generator on a client that is NEAR the target but not
#    ON it: co-locating means you measure the two competing for the same CPU, and the numbers are
#    meaningless. Bandwidth is the other constraint — a page-weight of ~45 KB at 380 req/s is ~17 MB/s
#    sustained, so a generator behind a slow link will fail to deliver the rate and crowdsim will mark
#    the run invalid.

job "crowdsim" {
  type        = "batch"
  datacenters = ["*"]

  parameterized {
    payload       = "optional"
    meta_required = ["target", "peak"]
    meta_optional = ["profile_url", "shape", "start", "steps", "step_dur", "hold", "rsc_mode",
                     "safe_peak", "force", "allow_targets", "extra_args"]
  }

  meta {
    shape    = "mix"
    start    = "30"
    steps    = "4"
    step_dur = "60s"
    hold     = "120s"
    rsc_mode = "repeat"
    force    = "false"
  }

  group "generator" {
    count = 1

    # count > 1 distributes the generator over several clients when one host cannot deliver the rate.
    # Remember that each instance then produces `peak` req/s: divide the peak yourself.
    constraint {
      attribute = "${attr.kernel.name}"
      value     = "linux"
    }

    restart {
      attempts = 0   # a load test does not get retried: a second uncontrolled run is a second outage
      mode     = "fail"
    }

    reschedule {
      attempts  = 0
      unlimited = false
    }

    ephemeral_disk {
      size = 500
    }

    task "crowdsim" {
      driver = "docker"

      config {
        # Pin a released tag, never `latest`: a load test you cannot reproduce is an anecdote. The same
        # image also serves the GUI (`crowdsim serve`), which is not what this job is for.
        image      = "ghcr.io/hiway-media/crowdsim:1.25.0"
        entrypoint = ["/bin/bash"]
        # absolute path: the image's workdir is /crowdsim, so a relative "local/run.sh" would not resolve
        command    = "/local/run.sh"
        # host network: NAT would add a hop that becomes the bottleneck before the target does
        network_mode = "host"
      }

      # The profile is NOT in the image and NOT in this file: it holds your hostnames, URL pools and
      # measured mix. Fetch it from your own private repo at dispatch time.
      artifact {
        source      = "${NOMAD_META_profile_url}"
        destination = "local/profile.json"
        mode        = "file"
      }

      template {
        destination = "local/run.sh"
        perms       = "755"
        data        = <<-EOS
        #!/usr/bin/env bash
        set -eo pipefail
        args=(load
          --profile /local/profile.json
          --target  '{{ env "NOMAD_META_target" }}'
          --peak    '{{ env "NOMAD_META_peak" }}'
          --start   '{{ env "NOMAD_META_start" }}'
          --steps   '{{ env "NOMAD_META_steps" }}'
          --step-dur '{{ env "NOMAD_META_step_dur" }}'
          --hold    '{{ env "NOMAD_META_hold" }}'
          --shape   '{{ env "NOMAD_META_shape" }}'
          --rsc-mode '{{ env "NOMAD_META_rsc_mode" }}')
        {{ if env "NOMAD_META_safe_peak" }}args+=(--safe-peak '{{ env "NOMAD_META_safe_peak" }}'){{ end }}
        # Going past the safe ceiling has to be asked for on the dispatch, every single time. It is
        # never remembered in the job file: a committed override is an outage waiting for a rerun.
        {{ if eq (env "NOMAD_META_force") "true" }}args+=(--i-know-this-breaks-production){{ end }}
        {{ if env "CROWDSIM_SLACK_WEBHOOK" }}args+=(--slack){{ end }}
        {{ with env "NOMAD_META_extra_args" }}args+=({{ . }}){{ end }}
        exec crowdsim "${args[@]}"
        EOS
      }

      env {
        CROWDSIM_OUT = "${NOMAD_ALLOC_DIR}/data"
        # Hard gate. Set it to the hosts this cluster is allowed to load-test; the dispatch can narrow
        # it but the job refuses to run without it.
        CROWDSIM_ALLOW_TARGETS = "${NOMAD_META_allow_targets}"
        # Where the login/authed classes look for `username,password` credentials. Pointing at the
        # secrets dir is safe for every other run: the generator reads this file only when a class in
        # the profile actually signs in, so an anonymous profile does not care whether it exists.
        # The file itself is rendered by the template below — it never lives in this repository.
        CROWDSIM_AUTH_USERS = "${NOMAD_SECRETS_DIR}/users.csv"
      }

      # Credentials for the authenticated classes. Same rule as the webhook: a secret belongs in a Nomad
      # variable or in Vault, never in this file. `secrets/` is a tmpfs inside the allocation, so the CSV
      # exists for the life of the run and nowhere else.
      #
      #   nomad var put nomad/jobs/crowdsim auth_users=@users.csv
      #
      # Uncomment when you run authenticated profiles. Give the accounts a dedicated mail domain: it is
      # the only thing that lets you find and delete them afterwards, and a signup class creates real
      # ones — a campaign that generated ~3,000 of them had no other way to identify them.
      # template {
      #   destination = "secrets/users.csv"
      #   change_mode = "noop"
      #   perms       = "0400"
      #   data        = "{{ with nomadVar \"nomad/jobs/crowdsim\" }}{{ .auth_users }}{{ end }}"
      # }

      # The Slack webhook is a secret: keep it in Vault or in a Nomad variable, never in this file.
      # template {
      #   destination = "secrets/slack.env"
      #   env         = true
      #   data        = "CROWDSIM_SLACK_WEBHOOK={{ with nomadVar \"nomad/jobs/crowdsim\" }}{{ .slack_webhook }}{{ end }}"
      # }

      resources {
        # The generator is CPU-bound at high rates: too little CPU and it silently fails to deliver the
        # requested rate, which crowdsim reports as generator_ok=false. Start here and watch that flag.
        cpu    = 4000
        memory = 2048
      }
    }
  }
}
