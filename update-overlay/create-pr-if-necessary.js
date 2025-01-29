module.exports = async ({
  github,
  core,
  overlayRepoOwner,
  overlayRepoName,
  overlayRepoBranchName,
  targetPRBranchName,
  backstageVersion,
  workspaceName,
  workspaceCommit,
  pluginsRepoOwner,
  pluginsRepoName,
  pluginsRepoFlat,
  pluginDirectories
}) => {
  try {
    const githubClient = github.rest;
    
    const workspacePath = `workspaces/${workspaceName}`;
    const pluginsRepoUrl = `https://github.com/${pluginsRepoOwner}/${pluginsRepoName}`;

    const pluginsYamlContent = pluginDirectories.replace(new RegExp(`^${workspacePath}/`, 'mg'));
    const sourceJsonContent = JSON.stringify({
      repo: pluginsRepoUrl,
      "repo-ref": workspaceCommit,
      "repo-flat": pluginsRepoFlat,
    });

    const workspaceLink = pluginsRepoFlat ?
      `/${pluginsRepoOwner}/${pluginsRepoName}/tree/${workspaceCommit}`
      : `/${pluginsRepoOwner}/${pluginsRepoName}/tree/${workspaceCommit}/workspaces/${workspaceName}`;

    // checking existing content on the target branch
    let needsUpdate = false;
    try {
      const checkExistingResponse = await githubClient.repos.getContent({
        owner: overlayRepoOwner,
        repo: overlayRepoName,
        mediaType: {
          format: 'text'        
        }, 
        path: `${workspacePath}/source.json`,
        ref: overlayRepoBranchName,
      })

      if (checkExistingResponse.status === 200) {
        console.log('workspace already exists on the target branch');
        const data = checkExistingResponse.data;
        if ('content' in data && data.content !== undefined) {
          const content = Buffer.from(data.content, 'base64').toString();
          const sourceInfo = JSON.parse(content); 
          if (sourceInfo['repo-ref'] === workspaceCommit.trim() &&
              sourceInfo['repo'] === pluginsRepoUrl &&
              sourceInfo['flat'] === pluginsRepoFlat
            ) {
            console.log('workspace already added with the same commit');
            await core.summary
              .addHeading('Workspace skipped')
              .addRaw('Workspace ')
              .addLink(workspaceName, workspaceLink)
              .addRaw(` already exists on branch ${overlayRepoBranchName} with the same commit ${workspaceCommit.substring(0,7)}`)
              .write()
            return;
          }
        }
        needsUpdate = true;
      }
    } catch(e) {
      if (e instanceof Object && 'status' in e && e.status === 404) {
        console.log(`workspace ${workspaceName} not found on branch ${overlayRepoBranchName}`)
      } else {
        throw e;
      }
    }

    // Checking pull request existence
    try {
      const prCheckResponse = await githubClient.git.getRef({
        owner: overlayRepoOwner,
        repo: overlayRepoName,
        ref: `heads/${targetPRBranchName}`
      })

      if (prCheckResponse.status === 200) {
        console.log('pull request branch already exists. Do not try to create it again.')
        await core.summary
          .addHeading('Workspace skipped')
          .addRaw(`Pull request branch ${targetPRBranchName} already exists.`, true)
          .write();
        return;
      }
    } catch(e) {
      if (e instanceof Object && 'status' in e && e.status === 404) {
        console.log(`pull request branch ${targetPRBranchName} doesn't already exist.`)
      } else {
        throw e;
      }
    }

    // getting latest commit sha and treeSha of the target branch
    const response = await githubClient.repos.listCommits({
      owner: overlayRepoOwner,
      repo: overlayRepoName,
      sha: overlayRepoBranchName,
      per_page: 1,
    })

    const latestCommitSha = response.data[0].sha;
    const treeSha = response.data[0].commit.tree.sha;
    
    console.log(`treeSha: ${treeSha}`);
    console.log(`overlayRepoOwner: ${overlayRepoOwner}`);
    console.log(`overlayRepoName: ${overlayRepoName}`);

    const treeResponse = await githubClient.git.createTree({
      owner: overlayRepoOwner,
      repo: overlayRepoName,
      base_tree: treeSha,
      tree: [
        { path: `${workspacePath}/plugins-list.yaml`, mode: '100644', content: pluginsYamlContent },
        { path: `${workspacePath}/source.json`, mode: '100644', content: sourceJsonContent }
      ]
    })
    const newTreeSha = treeResponse.data.sha

    const needsUpdateMessage = needsUpdate ? 'Update' : 'Add';
    const message = `${needsUpdateMessage} \`${workspaceName}\` workspace to commit \`${workspaceCommit.substring(0,7)}\` for backstage \`${backstageVersion}\` on branch \`${overlayRepoBranchName}\``

    console.log('creating commit')
    const commitResponse = await githubClient.git.createCommit({
      owner: overlayRepoOwner,
      repo: overlayRepoName,
      message,
      tree: newTreeSha,
      parents: [latestCommitSha],
    })
    const newCommitSha = commitResponse.data.sha

    // Creating branch
    await githubClient.git.createRef({
      owner: overlayRepoOwner,
      repo: overlayRepoName,
      sha: newCommitSha,
      ref: `refs/heads/${targetPRBranchName}`
    })

    // Creating pull request
    const prResponse = await githubClient.pulls.create({
      owner: overlayRepoOwner,
      repo: overlayRepoName,
      head: targetPRBranchName,
      base: overlayRepoBranchName,
      title: message,
      body: `${needsUpdateMessage} [${workspaceName}](${workspaceLink}) workspace at commit ${pluginsRepoOwner}/${pluginsRepoName}@${workspaceCommit} for backstage \`${backstageVersion}\` on branch \`${overlayRepoBranchName}\`.

  This PR was created automatically.
  You might need to complete it with additional dynamic plugin export information, like:
  - the associated \`app-config.dynamic.yaml\` file for frontend plugins,
  - optionally the \`scalprum-config.json\` file for frontend plugins,
  - optionally some overlay source files for backend or frontend plugins.
  `,
    });

    console.log(`Pull request created: ${prResponse.data.html_url}`);

    await core.summary
    .addHeading('Workspace PR created')
    .addLink('Pull request', prResponse.data.html_url)
    .addRaw(` on branch ${overlayRepoBranchName}`)
    .addRaw(' created for workspace ')
    .addLink(workspaceName, workspaceLink)
    .addRaw(` at commit ${workspaceCommit.substring(0,7)} for backstage ${backstageVersion}`)
    .write();
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.stack);
  }
}
