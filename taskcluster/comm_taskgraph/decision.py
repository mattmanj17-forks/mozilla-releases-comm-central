#  This Source Code Form is subject to the terms of the Mozilla Public
#  License, v. 2.0. If a copy of the MPL was not distributed with this
#  file, You can obtain one at http://mozilla.org/MPL/2.0/.

import argparse
import logging
import os
import sys

from redo import retry
from taskgraph.decision import (
    _determine_more_accurate_base_ref,
    _determine_more_accurate_base_rev,
    _get_env_prefix,
)
from taskgraph.taskgraph import TaskGraph
from taskgraph.util.taskcluster import get_artifact
from taskgraph.util.vcs import get_repository

from gecko_taskgraph.decision import ARTIFACTS_DIR, write_artifact
from gecko_taskgraph.parameters import get_app_version, get_version
from gecko_taskgraph.util.backstop import is_backstop
from gecko_taskgraph.util.hg import get_hg_commit_message
from gecko_taskgraph.util.partials import populate_release_history
from gecko_taskgraph.util.taskgraph import (
    find_decision_task,
    find_existing_tasks_from_previous_kinds,
)

from . import COMM
from comm_taskgraph.files_changed import get_changed_files
from comm_taskgraph.try_option_syntax import parse_message
from comm_taskgraph.util.suite import is_suite_only_push

logger = logging.getLogger(__name__)

BALROG_PRODUCT = "Thunderbird"

# Backstop defaults
BACKSTOP_TIME_INTERVAL = 60 * 22  # minutes
INTEGRATION_PROJECTS = {"comm-central"}

PER_PROJECT_PARAMETERS = {
    "ash": {
        "target_tasks_method": "ash_tasks",
    },
    "jamun": {
        "target_tasks_method": "nightly_desktop",
        "release_type": "nightly",
    },
    "try-comm-central": {
        "enable_always_target": True,
        "target_tasks_method": lambda parameters: (
            "try_cc_tasks"
            if (method := parameters.get("target_tasks_method")) == "default"
            else method
        ),
    },
    "comm-central": {
        "target_tasks_method": "comm_central_tasks",
        "release_type": "nightly",
    },
    "comm-beta": {
        "target_tasks_method": "mozilla_beta_tasks",
        "release_type": "beta",
    },
    "comm-release": {
        "target_tasks_method": "mozilla_release_tasks",
        "release_type": "release",
    },
    "comm-esr128": {
        "target_tasks_method": "mozilla_esr128_tasks",
        "release_type": "esr128",
    },
}

CRON_OPTIONS = {
    "nightly_desktop": {
        "existing_tasks": lambda parameters, graph_config: get_existing_tasks(
            parameters, graph_config
        ),
        "release_history": lambda parameters, graph_config: populate_release_history(
            BALROG_PRODUCT, parameters["project"]
        ),
    }
}


COMM_DEFAULTS = {
    "app_version": get_app_version(product_dir="comm/mail"),
    "version": get_version("comm/mail"),
    "comm_src_path": "comm/",
    "try_options": None,
}


def write_build_artifact(filename, data):
    build_artifact_path = os.path.dirname(os.path.join(ARTIFACTS_DIR, filename))
    if not os.path.isdir(build_artifact_path):
        os.mkdir(build_artifact_path)
    write_artifact(filename, data)


def gen_treeherder_build_links(params):
    """
    Create a JSON file that is used by Treeherder to display "Built from" links.
    """
    gecko_repo = params.get("head_repository")
    gecko_rev = params.get("head_rev")
    comm_repo = params.get("comm_head_repository")
    comm_rev = params.get("comm_head_rev")

    def mk_built_from_line(repo, revision):
        repo_name = repo.split("/")[-1]  # Last component of base URL
        title = f"Built from {repo_name} revision {revision}"
        url = f"{repo}/rev/{revision}"
        return dict(title=title, value=revision, url=url)

    built_from = [
        mk_built_from_line(gecko_repo, gecko_rev),
        mk_built_from_line(comm_repo, comm_rev),
    ]
    write_build_artifact("build/built_from.json", built_from)


def restore_options():
    """
    Some parameters need the original commandline arguments that are not passed
    to comm_taskgraph.get_decision_parameters. But, sys.argv is still around so
    they can be found out again.
    """
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-tasks-method")
    parser.add_argument("--tasks-for")
    result = parser.parse_known_args()
    return vars(result[0])


def get_decision_parameters(graph_config, parameters):
    logger.info("{}.get_decision_parameters called".format(__name__))

    commit_message = get_hg_commit_message(COMM)
    options = restore_options()

    # Apply default values for all Thunderbird CI projects - override some Gecko defaults!
    parameters.update(COMM_DEFAULTS)

    project = parameters["project"]

    if project in PER_PROJECT_PARAMETERS:
        for _parameter, _value in PER_PROJECT_PARAMETERS[project].items():
            parameters[_parameter] = _value(parameters) if callable(_value) else _value

        logger.info("project parameters set for project {} from {}.".format(project, __file__))
    else:
        # Projects without a target_tasks_method should not exist for Thunderbird CI
        raise Exception("No target_tasks_method is defined for project {}.".format(project))

    # `target_tasks_method` has higher precedence than `project` parameters
    if options.get("target_tasks_method"):
        parameters["target_tasks_method"] = options["target_tasks_method"]

    # ..but can be overridden by the commit message: if it contains the special
    # string "DONTBUILD" and this is an on-push decision task, then use the
    # special 'nothing' target task method.
    if "DONTBUILD" in commit_message and options["tasks_for"] == "hg-push":
        parameters["target_tasks_method"] = "nothing"

    del parameters["backstop"]
    parameters["backstop"] = is_backstop(
        parameters,
        trust_domain="comm",
        time_interval=BACKSTOP_TIME_INTERVAL,
        integration_projects=INTEGRATION_PROJECTS,
    )
    for n in (
        "COMM_BASE_REPOSITORY",
        "COMM_BASE_REV",
        "COMM_HEAD_REPOSITORY",
        "COMM_HEAD_REV",
        "COMM_HEAD_REF",
    ):
        val = os.environ.get(n, "")
        parameters[n.lower()] = val

    repo_path = COMM
    repo = get_repository(repo_path)
    logger.info("Determining comm_base_ref...")
    parameters["comm_base_ref"] = _determine_more_accurate_base_ref(
        repo,
        candidate_base_ref="",
        head_ref=parameters.get("comm_head_ref"),
        base_rev=parameters.get("comm_base_rev"),
    )
    logger.info("Determining comm_base_rev...")
    parameters["comm_base_rev"] = _determine_more_accurate_base_rev(
        repo,
        base_ref=parameters["comm_base_ref"],
        candidate_base_rev=parameters.get("comm_base_rev"),
        head_rev=parameters.get("comm_head_rev"),
        env_prefix=_get_env_prefix(graph_config),
    )

    # Calculate changed files here. Already have gecko's changed files when this
    # executes, so only need to add comm changed files
    parameters["files_changed"] += sorted(
        get_changed_files(
            parameters["comm_head_repository"],
            parameters["comm_head_rev"],
            parameters["comm_src_path"],
        )
    )

    # If the target method is nightly, we should build partials. This means
    # knowing what has been released previously.
    # An empty release_history is fine, it just means no partials will be built
    parameters.setdefault("release_history", dict())
    if parameters.get("tasks_for", "") == "cron":
        for key, _callable in CRON_OPTIONS.get(parameters["target_tasks_method"], {}).items():
            result = _callable(parameters, graph_config)
            parameters[key] = result

    # Do not run any jobs if this is a suite-only push, but the push could be used for
    # a cron decision task later (like for a Daily build)
    if is_suite_only_push(parameters) and options["tasks_for"] == "hg-push":
        logger.info("This is a suite-only push; setting target_tasks_method to 'nothing'.")
        parameters["target_tasks_method"] = "nothing"

    gen_treeherder_build_links(parameters)

    parameters["message"] = try_syntax_from_message(commit_message)
    if "try:" in parameters["message"]:
        parameters["try_mode"] = "try_option_syntax"
        parameters.update(parse_message(parameters["message"]))
    else:
        parameters["try_options"] = None


def get_existing_tasks(parameters, graph_config):
    """
    Find the decision task corresponding to the on-push graph, and return
    a mapping of labels to task-ids from it.
    """
    try:
        decision_task = retry(
            find_decision_task,
            args=(parameters, graph_config),
            attempts=4,
            sleeptime=5 * 60,
        )
    except Exception:
        logger.exception("Didn't find existing push task.")
        sys.exit(1)

    _, task_graph = TaskGraph.from_json(get_artifact(decision_task, "public/full-task-graph.json"))
    return find_existing_tasks_from_previous_kinds(task_graph, [decision_task], [])


def try_syntax_from_message(message):
    """
    Parse the try syntax out of a commit message, returning '' if none is
    found.
    """
    try_idx = message.find("try:")
    if try_idx == -1:
        return ""
    return message[try_idx:].split("\n", 1)[0]
