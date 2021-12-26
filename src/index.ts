import * as core from "@actions/core";
import { exec } from "@actions/exec";
import * as github from "@actions/github";
import fetch from "node-fetch";

const githubToken = core.getInput("github-token");
const vercelToken = core.getInput("vercel-token");
const vercelOrgId = core.getInput("vercel-org-id");
const vercelProjectId = core.getInput("vercel-project-id");
const isProduction = core.getInput("is-production") === "true";
const { context } = github;

const vercelDeploy = async (): Promise<string> => {
  let branchName;
  if (context.payload.pull_request) {
    branchName = context.payload.pull_request.head.ref;
  } else if (context.ref) {
    branchName = context.ref.replace("refs/heads/", "");
  } else {
    throw new Error("Branch name is undefined.");
  }

  let message;
  if (context.payload.pull_request) {
    message = context.payload.pull_request.title;
  } else if (context.payload.head_commit) {
    message = context.payload.head_commit.message;
  } else {
    message = `Deploy ${context.sha}`;
  }

  let outstr = "";
  const options = {
    listeners: {
      stdout: (data: Buffer) => {
        outstr += data.toString();
        core.info(data.toString());
      },
      stderr: (data: Buffer) => {
        core.info(data.toString());
      },
    },
  };

  const repoId = (context.repo as any).id as number;
  const args = [
    "vercel",
    ...(isProduction ? ["--prod"] : []),
    "-t",
    vercelToken,
    "-m",
    `githubCommitAuthorName=${context.actor}`,
    "-m",
    `githubCommitMessage=${message}`,
    "-m",
    `githubCommitOrg=${context.repo.owner}`,
    "-m",
    `githubCommitRef=${branchName}`,
    "-m",
    `githubCommitRepo=${context.repo.repo}`,
    "-m",
    `githubCommitRepoId=${repoId}`,
    "-m",
    `githubCommitSha=${context.sha}`,
    "-m",
    "githubDeployment=1",
    "-m",
    `githubOrg=${context.repo.owner}`,
    "-m",
    `githubRepo=${context.repo.repo}`,
    "-m",
    `githubRepoId=${repoId}`,
    "-m",
    `githubCommitAuthorLogin=${context.actor}`,
  ];
  await exec("npx", args, options);
  return outstr;
};

const vercelInspect = async (
  deploymentUrl: string
): Promise<{ projectName: string; inspectorUrl: string }> => {
  const getRes = await fetch(
    `https://api.vercel.com/v13/deployments/${deploymentUrl.replace(
      "https://",
      ""
    )}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${vercelToken}` },
    }
  );
  const res = await getRes.json();
  return {
    projectName: res.name,
    inspectorUrl: res.inspectorUrl,
  };
};

const buildComment = async ({
  titleText,
  deploymentUrl,
  inspectorUrl,
}: {
  titleText: string;
  deploymentUrl: string;
  inspectorUrl: string;
}) => {
  const sha = context.payload.pull_request
    ? context.payload.pull_request.head.sha
    : context.sha;
  return `${titleText}

🔍 Inspect: ${inspectorUrl}
✅ Preview: ${deploymentUrl}

Built with commit ${sha}.`;
};

const main = async () => {
  core.exportVariable("VERCEL_ORG_ID", vercelOrgId);
  core.exportVariable("VERCEL_PROJECT_ID", vercelProjectId);

  const deploymentUrl = await vercelDeploy();
  if (deploymentUrl) {
    core.setOutput("previewUrl", deploymentUrl);
  } else {
    throw new Error("previewUrl is undefined");
  }

  const info = await vercelInspect(deploymentUrl);

  const titleText = `Deployment preview for _${info.projectName}_.`;

  const octokit = github.getOctokit(githubToken);
  if (context.eventName === "pull_request") {
    const res = await octokit.rest.issues.listComments({
      ...context.repo,
      issue_number: context.issue.number,
    });
    const comment = res.data.find((v) => v.body?.includes(titleText));
    const commentId = comment && comment.id;
    if (commentId) {
      await octokit.rest.issues.updateComment({
        ...context.repo,
        comment_id: commentId,
        body: await buildComment({
          titleText,
          deploymentUrl,
          inspectorUrl: info.inspectorUrl,
        }),
      });
    } else {
      await octokit.rest.issues.createComment({
        ...context.repo,
        issue_number: context.issue.number,
        body: await buildComment({
          titleText,
          deploymentUrl,
          inspectorUrl: info.inspectorUrl,
        }),
      });
    }
  } else if (context.eventName === "push") {
    const res = await octokit.rest.repos.listCommentsForCommit({
      ...context.repo,
      commit_sha: context.sha,
    });
    const comment = res.data.find((v) => v.body.includes(titleText));
    const commentId = comment && comment.id;
    if (commentId) {
      await octokit.rest.repos.updateCommitComment({
        ...context.repo,
        comment_id: commentId,
        body: await buildComment({
          titleText,
          deploymentUrl,
          inspectorUrl: info.inspectorUrl,
        }),
      });
    } else {
      await octokit.rest.repos.createCommitComment({
        ...context.repo,
        commit_sha: context.sha,
        body: await buildComment({
          titleText,
          deploymentUrl,
          inspectorUrl: info.inspectorUrl,
        }),
      });
    }
  } else {
    core.info("Github comment is skipped.");
  }
};
main().catch((error) => {
  core.setFailed(error.message);
});
