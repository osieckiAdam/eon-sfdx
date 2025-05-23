import { SfProject, SfError, SfProjectJson, Org } from '@salesforce/core';
import { ComponentSet, MetadataApiDeploy, MetadataResolver, DeployDetails } from '@salesforce/source-deploy-retrieve';
import { DeployError } from '../../interfaces/package-interfaces';
import simplegit, { DiffResult, SimpleGit } from 'simple-git';
import fs from 'fs';
const util = require('util');
const exec = util.promisify(require('child_process').exec);
import {
    NamedPackageDirLarge,
    ApexTestclassCheck,
    SourcePackageComps,
    CodeCoverageWarnings,
    PackageCharacter,
} from '../../helper/types';
import EONLogger, {
    COLOR_INFO,
    COLOR_KEY_MESSAGE,
    COLOR_HEADER,
    COLOR_NOTIFY,
    COLOR_WARNING,
    COLOR_ERROR,
    COLOR_TRACE,
} from '../../eon/EONLogger';
import path from 'path';
import Table from 'cli-table3';
import ValidateDiff from './../../helper/validate';
import { Dictionary, Nullable } from '@salesforce/ts-types';

export interface SourcePackageImplProps {
    targetOrg: string;
    runScripts: boolean;
}

export default class SourcePackageImpl {
    constructor(private props: SourcePackageImplProps) {}
    public async exec(): Promise<any> {
        try {
            EONLogger.log(COLOR_KEY_MESSAGE('Validating source package(s)...'));
            // get sfdx project.json
            EONLogger.log(COLOR_NOTIFY(`Using target-org 👉 ${COLOR_INFO(this.props.targetOrg)}`));
            const org = await Org.create({ aliasOrUsername: this.props.targetOrg });

            // get all diffs from current to target branch

            const project = await SfProject.resolve();
            const projectJson: SfProjectJson = await project.retrieveSfProjectJson();
            const json = projectJson.getContents();
            const packageTrees: NamedPackageDirLarge[] = json.packageDirectories as NamedPackageDirLarge[];
            const packageAliases: Nullable<Dictionary<string>> = project.getPackageAliases();
            const packageMap = new Map<string, NamedPackageDirLarge>();

            const packageInfoTable = new Table({
                head: [COLOR_NOTIFY('Package Name')],
                colWidths: [50],
                wordWrap: true,
            });

            // first loop for changes detection
            const promises: Promise<void>[] = [];
            for (const pck of packageTrees) {
                if (pck.ignoreOnStage && Array.isArray(pck.ignoreOnStage) && pck.ignoreOnStage.includes('build')) {
                    EONLogger.log(COLOR_TRACE(`👆 Package ${pck.package} is ignored on validate stage. Skipping...`));
                    continue;
                }

                if (packageAliases[pck.package]) {
                    continue;
                }

                if (pck.type) {
                    continue;
                }

                const promise = this.checkPackageChanges(pck, packageMap, projectJson);

                promises.push(promise);
            }

            EONLogger.log(COLOR_NOTIFY(`🧐 Checking for changes in ${packageTrees.length} packages...`));

            await Promise.allSettled(promises);

            if (packageMap.size === 0) {
                EONLogger.log(
                    COLOR_NOTIFY(`✔ Found no source packages with changes. Process finished without validation`)
                );
                return {};
            }

            for (const [key, value] of packageMap) {
                packageInfoTable.push([key]);
            }

            EONLogger.log(COLOR_NOTIFY('👉 Following source packages with changes:'));
            EONLogger.log(COLOR_INFO(packageInfoTable.toString()));

            //run validation tasks
            for (const [key, value] of packageMap) {
                //Start deploy process
                //execute preDeployment Scripts
                if (value.preDeploymentScript && this.props.runScripts) {
                    EONLogger.log(COLOR_INFO(`☝ Found pre deployment script for package ${key}`));
                    await this.runDeploymentSteps(value.preDeploymentScript, 'preDeployment', key, org);
                }
                //Deploy Source Package
                if (key.search('src') > -1) {
                    await this.validateSourcePackage(path.normalize(value.path), key, org);
                    continue;
                }

                //execute postDeployment Scripts
                if (value.postDeploymentScript && this.props.runScripts) {
                    EONLogger.log(COLOR_INFO(`☝ Found post deployment script for package ${key}`));
                    EONLogger.log(COLOR_INFO(`☝ No post deployment execution in source validation job`));
                    //await this.runDeploymentSteps(value.postDeploymentScript, 'postDeployment', key);
                }
            }
            EONLogger.log(COLOR_HEADER(`Yippiee. 🤙 Validation finsihed without errors. Great 🤜🤛`));
        } catch (e) {
            EONLogger.log(COLOR_ERROR(e));
            if(e instanceof SfError) {
              throw new Error(e.message);
            } else if (e instanceof Error) {
              throw new Error(e.message);
            } else {
              throw new Error('Unknown error occured. Please contact your system administrator.');
            }
        }
        return {};
    }

    private async print(input: DeployDetails): Promise<void> {
        var table = new Table({
            head: ['Component Name', 'Error Message'],
            colWidths: [60, 60], // Requires fixed column widths
            wordWrap: true,
        });
        //print deployment errors
        if (
            (Array.isArray(input.componentFailures) && input.componentFailures.length > 0) ||
            (typeof input.componentFailures === 'object' && Object.keys(input.componentFailures).length > 0)
        ) {
            let result: DeployError[] = [];
            if (Array.isArray(input.componentFailures)) {
                result = input.componentFailures.map((a) => {
                    const res: DeployError = {
                        Name: a.fullName,
                        Type: a.componentType,
                        Status: a.problemType,
                        Message: a.problem,
                    };
                    return res;
                });
            } else {
                const res: DeployError = {
                    Name: input.componentFailures.fullName,
                    Type: input.componentFailures.componentType,
                    Status: input.componentFailures.problemType,
                    Message: input.componentFailures.problem,
                };
                result = [...result, res];
            }
            result.forEach((r) => {
                let obj = {};
                obj[r.Name] = r.Message;
                table.push(obj);
            });
            console.log(table.toString());
            throw new SfError(
                `Deployment failed. Please check error messages from table and fix this issues from package.`
            );
            // print test run errors
        } else if (
            (input.runTestResult &&
                input.runTestResult.failures &&
                Array.isArray(input.runTestResult.failures) &&
                input.runTestResult.failures.length > 0) ||
            (input.runTestResult &&
                typeof input.runTestResult.failures === 'object' &&
                Object.keys(input.runTestResult.failures).length > 0)
        ) {
            let tableTest = new Table({
                head: ['Apex Class', 'Message', 'Stack Trace'],
                colWidths: [60, 60, 60], // Requires fixed column widths
                wordWrap: true,
            });
            if (Array.isArray(input.runTestResult.failures)) {
                input.runTestResult.failures.forEach((a) => {
                    tableTest.push([a.name, a.message, a.stackTrace]);
                });
            } else {
                tableTest.push([
                    input.runTestResult.failures.name,
                    input.runTestResult.failures.message,
                    input.runTestResult.failures.stackTrace,
                ]);
            }
            console.log(tableTest.toString());
            throw new SfError(
                `Testrun failed. Please check the testclass errors from table and fix this issues from package.`
            );
            // print code coverage errors
        } else if (
            (input.runTestResult &&
                input.runTestResult.codeCoverageWarnings &&
                Array.isArray(input.runTestResult.codeCoverageWarnings) &&
                input.runTestResult.codeCoverageWarnings.length > 0) ||
            (input.runTestResult &&
                typeof input.runTestResult.codeCoverageWarnings === 'object' &&
                Object.keys(input.runTestResult.codeCoverageWarnings).length > 0)
        ) {
            if (Array.isArray(input.runTestResult.codeCoverageWarnings)) {
                const coverageList: CodeCoverageWarnings[] = input.runTestResult.codeCoverageWarnings;
                coverageList.forEach((a) => {
                    table.push([a.name, a.message]);
                });
            } else {
                const coverageList: CodeCoverageWarnings = input.runTestResult.codeCoverageWarnings;
                table.push([coverageList.name, coverageList.message]);
            }
            console.log(table.toString());
            throw new SfError(
                `Testcoverage failed. Please check the coverage from table and fix this issues from package.`
            );
        } else {
            throw new SfError(
                `Validation failed. No errors in the response. Please validate manual and check the errors on org (setup -> deployment status).`
            );
        }
    }

    private async runDeploymentSteps(scriptPath: string, scriptStep: string, scriptVariable1: string, org: Org) {
        EONLogger.log(COLOR_HEADER(`Execute deployment script`));
        EONLogger.log(`${COLOR_NOTIFY('Path:')} ${COLOR_INFO(scriptPath)}`);
        try {
            const cmdPrefix = process.platform !== 'win32' ? 'sh -e' : 'cmd.exe /c';
            const { stdout, stderr } = await exec(
                `${cmdPrefix} ${path.normalize(path.join(process.cwd(), scriptPath))} ${scriptVariable1} ${org
                    .getConnection()
                    .getUsername()} ${org.getConnection().getUsername()}`,
                { timeout: 0, encoding: 'utf-8', maxBuffer: 5242880 }
            );
            if (stderr) {
                EONLogger.log(COLOR_ERROR(`${scriptStep} Command Error: ${stderr}`));
            }
            if (stdout) {
                EONLogger.log(COLOR_INFO(`${scriptStep} Command Info: ${stdout}`));
            }
        } catch (e) {
            EONLogger.log(COLOR_ERROR(`${scriptStep} Command Error: ${e}`));
        }
    }

    private async validateSourcePackage(path: string, pck: string, org: Org) {
        EONLogger.log(COLOR_HEADER(`💪 Start Deployment and Tests for source package.`));
        let username = org.getConnection().getUsername();
        const sourceComps = await this.getApexClassesForSource(path);
        const testLevel = sourceComps.apexTestclassNames.length > 0 ? 'RunSpecifiedTests' : 'NoTestRun';
        EONLogger.log(COLOR_HEADER(`Validate source package: ${pck}`));
        EONLogger.log(`${COLOR_NOTIFY('Path:')} ${COLOR_INFO(path)}`);
        EONLogger.log(`${COLOR_NOTIFY('Metadata Size:')} ${COLOR_INFO(sourceComps.comps.length)}`);
        EONLogger.log(`${COLOR_NOTIFY('TestLevel:')} ${COLOR_INFO(testLevel)}`);
        EONLogger.log(`${COLOR_NOTIFY('Username:')} ${COLOR_INFO(username)}`);
        EONLogger.log(
            `${COLOR_NOTIFY('ApexClasses:')} ${
                sourceComps.apexClassNames.length > 0
                    ? COLOR_INFO(sourceComps.apexClassNames.join())
                    : COLOR_INFO('no Apex Classes in source package')
            }`
        );
        EONLogger.log(
            `${COLOR_NOTIFY('ApexTestClasses:')} ${
                sourceComps.apexTestclassNames.length > 0
                    ? COLOR_INFO(sourceComps.apexTestclassNames.join())
                    : COLOR_INFO('no Apex Test Classes in source package')
            }`
        );

        if (sourceComps.apexClassNames.length > 0 && sourceComps.apexTestclassNames.length === 0) {
            throw new SfError(
                `Found apex class(es) for package ${pck} but no testclass(es). Please create a new testclass.`
            );
        }

        const deploy: MetadataApiDeploy = await ComponentSet.fromSource(path).deploy({
            usernameOrConnection: username,
            apiOptions: { checkOnly: true, testLevel: testLevel, runTests: sourceComps.apexTestclassNames },
        });
        // Attach a listener to check the deploy status on each poll
        let counter = 0;
        deploy.onUpdate((response) => {
            if (counter === 5) {
                const {
                    status,
                    numberComponentsDeployed,
                    numberComponentsTotal,
                    numberTestsTotal,
                    numberTestsCompleted,
                    stateDetail,
                } = response;
                const progress = `${numberComponentsDeployed}/${numberComponentsTotal}`;
                const testProgress = `${numberTestsCompleted}/${numberTestsTotal}`;
                let message = '';
                if (numberComponentsDeployed < sourceComps.comps.length) {
                    message = `⌛ Deploy Package: ${pck} Status: ${status} Progress: ${progress}`;
                } else if (numberComponentsDeployed === numberComponentsTotal && numberTestsTotal > 0) {
                    message = `⌛ Test Package: ${pck} Status: ${status} Progress: ${testProgress} ${
                        stateDetail ?? ''
                    }`;
                } else if (numberTestsTotal === 0 && sourceComps.apexTestclassNames.length > 0) {
                    message = `⌛ Waiting for testclass execution`;
                }
                EONLogger.log(COLOR_TRACE(message));
                counter = 0;
            } else {
                counter++;
            }
        });

        // Wait for polling to finish and get the DeployResult object
        const res = await deploy.pollStatus();
        if (!res.response.success) {
            await this.print(res.response.details);
        } else {
            EONLogger.log(COLOR_INFO(`✔ Deployment and tests for source package ${pck} successfully 👌`));
        }
    }

    private async getApexClassesForSource(path: string): Promise<SourcePackageComps> {
        const sourcePckComps: SourcePackageComps = { comps: [], apexClassNames: [], apexTestclassNames: [] };
        const resolver: MetadataResolver = new MetadataResolver();

        for (const component of resolver.getComponentsFromPath(path)) {
            sourcePckComps.comps.push(component.name);
            if (component.type.id === 'apexclass') {
                const apexCheckResult: ApexTestclassCheck = await this.checkIsSourceTestClass(component.content);
                if (apexCheckResult.isTest) {
                    sourcePckComps.apexTestclassNames.push(component.name);
                } else {
                    sourcePckComps.apexClassNames.push(component.name);
                }
            }
        }

        return sourcePckComps;
    }

    //check if apex class is a testclass from code identifier @isTest
    private async checkIsSourceTestClass(comp: string): Promise<ApexTestclassCheck> {
        let checkResult: ApexTestclassCheck = { isTest: false };
        try {
            const data = await fs.promises.readFile(comp, 'utf8');
            if (data.search('@isTest') > -1 || data.search('@IsTest') > -1) {
                checkResult.isTest = true;
            }
        } catch (err) {
            EONLogger.log(COLOR_TRACE(err));
            return checkResult;
        }
        return checkResult;
    }

    async checkPackageChanges(
        pck: NamedPackageDirLarge,
        packageMap: Map<string, NamedPackageDirLarge>,
        projectJson: SfProjectJson
    ): Promise<void> {
        if (pck.ignoreOnStage && Array.isArray(pck.ignoreOnStage) && pck.ignoreOnStage.includes('validate')) {
            return;
        }

        const hasGitDiff = await ValidateDiff.getInstance().getGitDiff(pck, projectJson);
        if (hasGitDiff) {
            packageMap.set(pck.package!, pck);
        }
    }
}
