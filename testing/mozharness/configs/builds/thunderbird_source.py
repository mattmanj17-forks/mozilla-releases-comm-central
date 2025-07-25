# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

config = {
    "default_actions": ["package-source"],
    "upload_env": {
        "UPLOAD_PATH": "/builds/worker/artifacts",
    },
    "stage_platform": "source",  # Not used, but required by the script
    "app_ini_path": "FAKE",  # Not used, but required by the script
    "env": {
        "HG_SHARE_BASE_DIR": "/builds/hg-shared",
        "TINDERBOX_OUTPUT": "1",
        "LC_ALL": "C",
        "MOZ_OBJDIR": "%(abs_obj_dir)s",
    },
    "src_mozconfig": "comm/mail/config/mozconfigs/linux64/source",
}
